import { Record } from 'neo4j-driver';
import { Neo4jClient } from '../../database/Neo4jClient';
import { DependencyCycle } from '../../entities/violations';
import { INeo4jComponentRelationship, INeo4jComponentNode } from '../../database/entities';
import { ExtendedSimpleEdgeData } from '../../entities/Edge';
import { DependencyCycleRender } from '../../entities/violations/DependencyCycle';
import { Neo4jDependencyRelationship } from '../../entities';
import ElementParserService from '../processing/ElementParserService';
import { MapSet } from '../../entities/MapSet';
import Neo4jComponentNode from '../../entities/Neo4jComponentNode';

interface Neo4jDependencyPath {
  path: {
    start: INeo4jComponentNode,
    end: INeo4jComponentNode,
    segments: {
      start: INeo4jComponentNode,
      relationship: INeo4jComponentRelationship,
      end: INeo4jComponentNode,
    }[],
  },
}

export default class ViolationCyclicalDependenciesService {
  private readonly client: Neo4jClient;

  constructor(client?: Neo4jClient) {
    this.client = client ?? new Neo4jClient();
  }

  private formatDependencyCycles(
    records: Record<Neo4jDependencyPath>[],
  ): DependencyCycle[] {
    return records.map((r): DependencyCycle => {
      const { start, segments } = r.get('path');
      return {
        node: ElementParserService.toNodeData(start),
        path: segments.map((s): ExtendedSimpleEdgeData => ({
          ...ElementParserService.toSimpleEdgeData(s.relationship),
          sourceNode: ElementParserService.toNodeData(s.start),
          targetNode: ElementParserService.toNodeData(s.end),
        })),
        length: segments.length,
      };
    });
  }

  public async getDependencyCycles(elementIds?: string[]): Promise<DependencyCycle[]> {
    const whereClause = elementIds ? `WHERE elementId(n) IN [${elementIds.join(',')}]` : '';
    /**
     * Neo4j procedure to find all cycles with the given set of nodes as a starting point.
     * Internally, this procedure simply loops over all these nodes and finds their relationships.
     * Then, for every relationship it checks whether there exists a path from the end node to
     * the start node. This is done using a Neo4j-internal method, probably BFS.
     *
     * Source:
     * https://github.com/neo4j/apoc/blob/0e8e8a6644fedd0665ac89321a40381a2c262b15/core/src/main/java/apoc/nodes/Nodes.java#L125
     * https://neo4j.com/docs/cypher-manual/current/appendix/tutorials/shortestpath-planning/
     * https://github.com/neo4j/neo4j/blob/b76dd4f846db9ba411e531d3e5c458614162c7ba/community/graph-algo/src/main/java/org/neo4j/graphalgo/impl/path/ShortestPath.java#L209
     */
    const query = `
      MATCH (n ${whereClause})
      WITH collect(n) as nodes
      CALL apoc.nodes.cycles(nodes)
      YIELD path
      RETURN path
    `;
    const records = await this.client
      .executeQuery<Neo4jDependencyPath>(query);
    return this.formatDependencyCycles(records);
  }

  /**
   * Given a list of (indirect) dependency cycles, perform the same abstraction as is
   * performed on the graph. Then, remove all cycles that are not in the graph.
   * @param dependencyCycles
   * @param dependencies
   * @param nodes
   */
  public extractAndAbstractDependencyCycles(
    dependencyCycles: DependencyCycle[],
    dependencies: MapSet<Neo4jDependencyRelationship>,
    nodes: MapSet<Neo4jComponentNode>,
  ): DependencyCycleRender[] {
    const cycleIndex = (d1: DependencyCycle) => `${d1.node.id}--${d1.path.map((p) => p.id).join('-')}`;

    return dependencyCycles.map((dep) => {
      const newDep: DependencyCycleRender = { ...dep, actualCycles: [dep], id: cycleIndex(dep) };
      const newPath = dep.path.map((d): ExtendedSimpleEdgeData => {
        const existingEdge = dependencies.getOriginal(d.id);

        // Edge exists within the rendered graph
        if (existingEdge) {
          existingEdge.violations.dependencyCycle = true;
          const sourceNode = ElementParserService.toNodeData(existingEdge.startNode);
          const targetNode = ElementParserService.toNodeData(existingEdge.startNode);
          return {
            ...d,
            id: existingEdge.elementId,
            source: existingEdge.startNode.elementId,
            sourceNode,
            target: existingEdge.endNode.elementId,
            targetNode,
          };
        }

        // Edge not found, so we have to find the source and target nodes
        // manually (if they even exist)
        const newD = { ...d };

        const originalSourceNode = nodes.get(d.source);
        const sourceNode = originalSourceNode?.originalNodeBeforeLifting ?? originalSourceNode;
        if (sourceNode) {
          newD.source = sourceNode.elementId;
          newD.sourceNode = ElementParserService.toNodeData(sourceNode);
        }
        const originalTargetNode = nodes.get(d.target);
        const targetNode = originalTargetNode?.originalNodeBeforeLifting ?? originalTargetNode;
        if (targetNode) {
          newD.target = targetNode.elementId;
          newD.targetNode = ElementParserService.toNodeData(targetNode);
        }
        return newD;
      });

      newDep.path = newPath
        // Keep at most only one self edge if the cyclical dependency is fully contained.
        // If not, remove any self edges from the chain
        .filter((e, index, all) => {
          if (index === 0 && all.every((e2) => e2.source === e2.target)) return true;
          return e.source !== e.target;
        });
      newDep.node = newPath[0].sourceNode;

      return newDep;
      // Keep only dependency cycles that have at least one dependency edge visualized in the graph
    }).filter((d) => d.path.some((p) => dependencies.has(p.id)))
      // Generate a new ID for each dependency cycle
      .map((d): DependencyCycleRender => ({ ...d, id: cycleIndex(d) }))
      // Merge all dependency cycles with the same ID
      .reduce((violations: DependencyCycleRender[], d) => {
        const index = violations.findIndex((d1) => d1.id === d.id);
        if (index >= 0) {
          // eslint-disable-next-line no-param-reassign
          violations[index].actualCycles = violations[index].actualCycles.concat(d.actualCycles);
        } else {
          violations.push(d);
        }
        return violations;
      }, []);
  }
}
