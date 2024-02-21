import {
  Edge, Graph, Neo4jComponentPath, Node,
} from '../../entities';
import { INeo4jComponentRelationship } from '../../database/entities';
import GraphElementParserService from './GraphElementParserService';
import GraphPreProcessingService from './GraphPreProcessingService';
import { Neo4jDependencyType } from '../../entities/Neo4jComponentPath';

export interface Range {
  min: number;
  max: number;
}

/**
 * @property selectedId - ID of the selected node to highlight it
 * @property maxDepth - How deep the "CONTAIN" edges on the target side should go.
 * If there is a path between two nodes too deep, create a transitive edge
 * @property selfEdges - If self edges should be returned
 */
export interface BasicGraphFilterOptions {
  maxDepth?: number;
  selfEdges?: boolean;
}

/**
 * @property dependencyRange - How many outgoing arrows a node is allowed to have
 * @property dependentRange - How many incoming arrows a node is allowed to have
 */
export interface GraphFilterOptions extends BasicGraphFilterOptions {
  dependencyRange?: Partial<Range>;
  dependentRange?: Partial<Range>;
}

export default class GraphProcessingService {
  public readonly original: GraphPreProcessingService;

  constructor(
    preprocessor: GraphPreProcessingService,
    public readonly contextGraph: Graph = { edges: [], nodes: [], name: 'undefined' },
  ) {
    this.original = preprocessor;
  }

  /**
   * Given a complete Neo4j graph query result, create a mapping from module IDs
   * to their abstractions
   * @param maxDepth
   */
  getAbstractionMap(
    maxDepth: number,
  ): Map<string, string> {
    // Replace all transitive nodes with this existing end node (the first of the full path)
    const replaceMap = new Map<string, string>();
    const addToReplaceMap = (deletedEdges: INeo4jComponentRelationship[]) => {
      if (deletedEdges.length === 0) return;
      const firstStartNode = deletedEdges[0].startNodeElementId;
      deletedEdges.forEach((edge) => replaceMap
        .set(edge.endNodeElementId, firstStartNode));
    };

    this.original.records.forEach((record) => {
      const containsSourceDepth = record.sourceDepth;
      const containsTargetDepth = record.targetDepth;
      const containsTooDeep = Math.max(0, containsSourceDepth - maxDepth);

      const deletedSource = record.containSourceEdges.splice(maxDepth, containsTooDeep);
      addToReplaceMap(deletedSource);

      const deletedTarget = record.containTargetEdges
        .splice(containsTargetDepth - containsTooDeep, containsTooDeep);
      addToReplaceMap(deletedTarget);
    });

    return replaceMap;
  }

  /**
   * Given a list of records, return a list of all edges in the records, all having weight 1.
   * The resulting list might include duplicate edges.
   * @param records
   */
  getAllEdges(records: Neo4jComponentPath[]): Edge[] {
    const seenEdges: string[] = [];
    return records
      .map((record) => record.allEdges.map((r): Edge | undefined => {
        const edgeId = r.elementId;
        if (seenEdges.indexOf(edgeId) >= 0) return undefined;
        seenEdges.push(edgeId);
        return {
          data: GraphElementParserService.toEdgeData(r),
        };
      }))
      .flat()
      .flat()
      .filter((edge) => edge !== undefined)
      // Typescript is being stupid, so set typing so all edges exist
      .map((edge): Edge => edge!);
  }

  /**
   * Given a list of edges, merge two edges with the same source and target node.
   * The merged edge's weight will be the sum of both edge weights.
   * @param edges
   */
  mergeDuplicateEdges(edges: Edge[]): Edge[] {
    return edges.reduce((newEdges: Edge[], edge) => {
      const index = newEdges.findIndex((e) => e.data.source === edge.data.source
        && e.data.target === edge.data.target);
      if (index < 0) return [...newEdges, edge];
      // eslint-disable-next-line no-param-reassign
      newEdges[index].data.properties.weight += edge.data.properties.weight;
      return newEdges;
    }, []);
  }

  /**
   * Apply an abstraction based on the grouping (clustering) of the nodes
   * @param records List of paths
   * @param abstractionMap Mapping with which node ids should be abstracted to which node ids
   */
  applyAbstraction(records: Neo4jComponentPath[], abstractionMap: Map<string, string>) {
    return records.map((record): Neo4jComponentPath => {
      // eslint-disable-next-line no-param-reassign
      record.dependencyEdges = record.dependencyEdges.map((e) => {
        if (abstractionMap.has(e.startNodeElementId)) {
          e.startNodeElementId = abstractionMap.get(e.startNodeElementId) as string;
        }
        if (abstractionMap.has(e.endNodeElementId)) {
          e.endNodeElementId = abstractionMap.get(e.endNodeElementId) as string;
        }
        e.setNodeReferences([...this.original.nodes, ...this.contextGraph.nodes]);
        return e;
      });
      return record;
    });
  }

  /**
   * Apply a filtering based on the amount of incoming and outgoing relationships
   * @param records
   * @param outgoing Count outgoing relationships, i.e. dependencies
   * @param minRelationships
   * @param maxRelationships
   */
  applyMinMaxRelationshipsFilter(
    records: Neo4jComponentPath[],
    outgoing = true,
    minRelationships?: number,
    maxRelationships?: number,
  ) {
    // Count how many relationships each child of the selected node has
    const relationsMap = new Map<string, string[]>();
    records.forEach((record) => {
      if (!minRelationships && !maxRelationships) return;

      // eslint-disable-next-line prefer-destructuring
      const edge = record.dependencyEdges.flat()[0]; // Last element of first chunk
      const isDependency = record.type === Neo4jDependencyType.DEPENDENCY;
      let node: string;
      let relatedNode: string;
      if ((outgoing && isDependency) || (!outgoing && !isDependency)) {
        node = edge?.startNodeElementId;
        relatedNode = edge?.endNodeElementId;
      } else {
        node = edge?.endNodeElementId;
        relatedNode = edge?.startNodeElementId;
      }

      if (!relatedNode) return;

      if (!relationsMap.get(node)?.includes(relatedNode)) {
        const currentRelations = relationsMap.get(node) || [];
        relationsMap.set(node, [...currentRelations, relatedNode]);
      }
    });

    // Apply filter
    return records.filter((record) => {
      if (!minRelationships && !maxRelationships) return true;

      const node = record.selectedModuleElementId;

      const uniqueRelationships = relationsMap.get(node) || [];
      if (minRelationships && uniqueRelationships.length < minRelationships) return false;
      if (maxRelationships && uniqueRelationships.length > maxRelationships) return false;
      return true;
    });
  }

  /**
   * Only keep the nodes that are the start or end point of an edge
   */
  filterNodesByEdges(nodes: Node[], edges: Edge[]): Node[] {
    const nodesOnPaths: string[] = edges
      // Get the source and target from each edge
      .map((e) => [e.data.source, e.data.target])
      // Flatten the 2D array
      .flat()
      // Remove duplicates
      .filter((n1, i, all) => i === all.findIndex((n2) => n1 === n2));
    // Filter the actual node objects
    return nodes.filter((n) => nodesOnPaths.includes(n.data.id));
  }

  /**
   * Remove all self-edges (edges where the source and target is the same node)
   */
  filterSelfEdges(edges: Edge[]): Edge[] {
    return edges.filter((e) => e.data.source !== e.data.target);
  }

  /**
   * Replace every given edge with a parent relationship, which is supported by Cytoscape.
   */
  addParentRelationship(nodes: Node[], parentEdges: Edge[]): Node[] {
    const nodesCopy: Node[] = [...nodes];
    parentEdges.forEach((e) => {
      const target = nodesCopy.find((n) => n.data.id === e.data.target);
      if (!target) return;
      target.data.parent = e.data.source;
    });
    return nodesCopy;
  }

  /**
   *
   */
  replaceEdgeWithParentRelationship(
    nodes: Node[],
    edges: Edge[],
    relationship: string,
  ): { nodes: Node[], dependencyEdges: Edge[] } {
    // Split the list of edges into "contain" edges and all other edges
    const containEdges = edges.filter((e) => e.data.interaction === relationship);
    const dependencyEdges = edges.filter((e) => e.data.interaction !== relationship);

    // Replace every "contain" edge with a parent relationship, which is supported by Cytoscape.
    const newNodes = this.addParentRelationship(nodes, containEdges);

    return { nodes: newNodes, dependencyEdges };
  }

  /**
   * Parse the given Neo4j query result to a LPG
   * @param name graph name
   * @param options
   */
  formatToLPG(
    name: string,
    options: BasicGraphFilterOptions = {},
  ): Graph {
    const {
      maxDepth, selfEdges,
    } = options;

    let filteredRecords = this.original.records;

    // Find the nodes that need to be replaced (and with which nodes).
    // Also, already remove the too-deep nodes
    let replaceMap: Map<string, string> | undefined;
    if (maxDepth !== undefined) {
      replaceMap = this.getAbstractionMap(maxDepth);
      filteredRecords = this.applyAbstraction(filteredRecords, replaceMap);
    }

    let edges = this.getAllEdges(filteredRecords);
    edges = this.mergeDuplicateEdges(edges);

    const nodes = this.filterNodesByEdges(this.original.nodes, edges);

    const replaceResult = this.replaceEdgeWithParentRelationship(nodes, edges, 'contains');

    if (selfEdges === false) {
      replaceResult.dependencyEdges = this.filterSelfEdges(replaceResult.dependencyEdges);
    }

    return {
      name,
      nodes: replaceResult.nodes,
      edges: replaceResult.dependencyEdges,
    };
  }
}
