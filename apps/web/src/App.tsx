import { FlowCanvas } from "./canvas/FlowCanvas";
import { SAMPLE_GRAPH } from "./sample-graph";

export function App() {
  return (
    <div className="awo-app">
      <header className="awo-app__header">Workflow: 把业务流程固化成流水线</header>
      <FlowCanvas graph={SAMPLE_GRAPH} />
    </div>
  );
}
