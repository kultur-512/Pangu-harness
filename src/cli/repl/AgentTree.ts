// src/cli/repl/AgentTree.ts
// sub-agent rollout tree — pure state model, fully testable.
//
// 诚实契约：high+ 档位的 rollout 并发执行（TestTimeOrchestrator
// Promise.allSettled + 写互斥），树渲染真实并行视图（多个 running 节点并存）；
// quick/standard 串行执行，展示顺序进度列表。从不伪造状态——节点仅从
// 真实 onEvent step/critique 数据 upsert。

export interface AgentNode {
  id: string;                 // rolloutId (e.g. rollout-0)
  parent: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  stepCount: number;
  durationMs: number;
  lastPhase?: string;
}

// 图边 — 依赖 / 回滚 / 审批路由。
export interface AgentEdge {
  from: string;
  to: string;
  kind: 'dep' | 'rollback' | 'approval';
}

const STATUS_ORDER = { pending: 0, running: 1, done: 2, failed: 3 } as const;

export class AgentTree {
  private nodes = new Map<string, AgentNode>();
  private edgesList: AgentEdge[] = [];

  /** Idempotent merge: never regresses status/stepCount unless explicitly told. */
  upsert(node: AgentNode): void {
    const prev = this.nodes.get(node.id);
    if (!prev) {
      this.nodes.set(node.id, { ...node });
      return;
    }
    const merged: AgentNode = {
      ...prev,
      ...node,
      stepCount: Math.max(prev.stepCount || 0, node.stepCount || 0),
      // durationMs: prefer the larger (newest) measurement
      durationMs: Math.max(prev.durationMs || 0, node.durationMs || 0),
      // status only upgrades pending→running→done/failed
      status: STATUS_ORDER[node.status] >= STATUS_ORDER[prev.status] ? node.status : prev.status,
    };
    this.nodes.set(node.id, merged);
  }

  /** 加一条边（from+to+kind 去重）。端点缺失时为 no-op。 */
  addEdge(edge: AgentEdge): void {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) return;
    if (this.edgesList.some((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) return;
    this.edgesList.push({ ...edge });
  }

  edges(): AgentEdge[] {
    return [...this.edgesList];
  }

  /** 从 `id` 出发沿指定 kind 的边可达的节点。 */
  route(id: string, kind: AgentEdge['kind']): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const walk = (cur: string) => {
      for (const e of this.edgesList) {
        if (e.from === cur && e.kind === kind && !seen.has(e.to)) {
          seen.add(e.to);
          out.push(e.to);
          walk(e.to);
        }
      }
    };
    walk(id);
    return out;
  }

  get(id: string): AgentNode | null {
    return this.nodes.get(id) ?? null;
  }

  /** Mark every node of a given status (e.g. running→done at task end). */
  markAll(from: AgentNode['status'], to: AgentNode['status']): void {
    for (const [id, n] of this.nodes) {
      if (n.status === from) this.nodes.set(id, { ...n, status: to });
    }
  }

  /**
   * Stable ordering: parents before children, siblings in insertion order.
   * Serial tiers (quick/standard) yield all-null parents → insertion order;
   * parallel tiers (high+) may have running children coexisting.
   */
  snapshot(): AgentNode[] {
    const ids = [...this.nodes.keys()];
    const out: AgentNode[] = [];
    const pushed = new Set<string>();
    const push = (id: string) => {
      if (pushed.has(id)) return;
      pushed.add(id);
      const n = this.nodes.get(id)!;
      out.push(n);
      for (const c of ids) {
        const cn = this.nodes.get(c)!;
        if (cn.parent === id) push(c);
      }
    };
    for (const id of ids) {
      const n = this.nodes.get(id)!;
      if (n.parent === null) push(id);
    }
    // roots already pushed; push any stragglers (parent id never seen)
    for (const id of ids) push(id);
    return out;
  }

  get size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.nodes.clear();
  }
}
