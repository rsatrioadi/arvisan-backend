import { IntermediateGraph, Edge } from '../../entities';
import { MapSet } from '../../entities/MapSet';
import Neo4jComponentNode from '../../entities/Neo4jComponentNode';

export default class PostProcessingService {
  private readonly _graph: IntermediateGraph;

  constructor(...graphs: IntermediateGraph[]) {
    if (graphs.length === 1) {
      [this._graph] = graphs;
    } else {
      this._graph = this.mergeGraphs(...graphs);
    }

    this.validateGraph(this._graph);
  }

  public get graph() {
    return this._graph;
  }

  /**
   * Merge two or more graphs into a single graph. Take out any duplicate nodes or edges
   * @param graphs
   * @private
   */
  private mergeGraphs(...graphs: IntermediateGraph[]): IntermediateGraph {
    const nodes = graphs.map((g) => g.nodes).flat();
    const edges = graphs.map((g) => g.edges).flat();
    return {
      name: `Merged graph of '${graphs.map((g) => g.name).join(', ')}'`,
      nodes: new MapSet<Neo4jComponentNode>(...nodes),
      edges: new MapSet<Edge>(...edges),
    };
  }

  /**
   * Given a graph with nodes and edges, validate that for each edge
   * its source and target node exists in the list of nodes.
   * @param graph
   * @throws Error One or more edges is missing its source and/or target node
   */
  public validateGraph(graph: IntermediateGraph) {
    const nodeIds = [...graph.nodes.keys()];
    const invalidEdges = graph.edges
      .map((e): Edge => ({
        data: {
          ...e.data,
          source: nodeIds.includes(e.data.source) ? '' : e.data.source,
          target: nodeIds.includes(e.data.target) ? '' : e.data.target,
        },
      }))
      .filter((e) => (e.data.source !== '' || e.data.target !== ''));
    if (invalidEdges.length === 0) return;
    const message = invalidEdges.map((e) => {
      if (e.data.source === '') {
        return `Edge '${e.data.id}': unknown target '${e.data.target}'`;
      }
      if (e.data.target === '') {
        return `Edge '${e.data.id}': unknown source '${e.data.source}'`;
      }
      return `Edge '${e.data.id}': unknown source '${e.data.source}' and target '${e.data.target}'`;
    });
    throw new Error(`Graph '${graph.name}' is invalid due to the following edges: ${message.join('; ')}`);
  }
}
