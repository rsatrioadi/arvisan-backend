import { Record } from 'neo4j-driver';
import { Neo4jComponentPath } from '../../database/entities';
import { Neo4jComponentPathWithChunks, Node } from '../../entities';
import GraphElementParserService from './GraphElementParserService';

export default class GraphPreProcessingService {
  public readonly nodes: Node[];

  public readonly records: Neo4jComponentPathWithChunks[];

  constructor(records: Record<Neo4jComponentPath>[], selectedId?: string) {
    this.nodes = this.getAllNodes(records, selectedId);

    const chunkRecords = this.splitRelationshipsIntoChunks(records);
    this.records = this.onlyKeepLongestPaths(chunkRecords);
  }

  /**
   * Given a list of records, return a list of all unique nodes in the records
   * @param records
   * @param selectedId
   */
  private getAllNodes(records: Record<Neo4jComponentPath>[], selectedId?: string): Node[] {
    const seenNodes: string[] = [];
    return records
      .map((r) => [r.get('source'), r.get('target')]
        .map((field): Node | undefined => {
          const nodeId = field.elementId;
          if (seenNodes.indexOf(nodeId) >= 0) return undefined;
          seenNodes.push(nodeId);
          return {
            data: GraphElementParserService.formatNeo4jNodeToNodeData(field, selectedId),
          };
        }))
      .flat()
      .filter((node) => node !== undefined) as Node[];
  }

  /**
   * Return the given records, but split/group the relationships into chunks of the same
   * type of relationship. See also this.groupRelationships().
   * @param records
   */
  private splitRelationshipsIntoChunks(
    records: Record<Neo4jComponentPath>[],
  ): Neo4jComponentPathWithChunks[] {
    return records
      .map((record) => (new Neo4jComponentPathWithChunks(record)));
  }

  /**
   * Keep only the paths that go from selected node to the domain node of the relationship
   * We have to delete any duplicates, because otherwise all these extra paths count towards
   * the total number of relationship a leaf has.
   * @param records
   */
  private onlyKeepLongestPaths(records: Neo4jComponentPathWithChunks[]) {
    const seenPaths = new Map<string, number>();
    return records
      .map((record) => {
        // String that will uniquely identify this dependency (sequence).
        const pathId = record.dependencyEdges.flat().map((e) => e.elementId).join(',');

        let currDepth = 0;
        if (seenPaths.has(pathId)) {
          currDepth = seenPaths.get(pathId)!;
        }

        seenPaths.set(pathId, Math.max(currDepth, record.targetDepth));

        return record;
      }).filter((record) => {
        const pathId = record.dependencyEdges.flat().map((e) => e.elementId).join(',');
        const depth = seenPaths.get(pathId) || 0;

        return record.targetDepth === depth;
      });
  }
}