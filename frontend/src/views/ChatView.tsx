import { ViewPage } from '../components/ViewLayout';
import { useRuntime } from '../app/runtime';
import { AgentSurface } from '../features/agents/AgentSurface';
import '../styles/features/chat.css';

/** The conversations with the agents. No view header: the tab already names the view. */
export function ChatView() {
  useRuntime();
  return <ViewPage className="chat-view" label="Agents">
    <div className="chat-layout">
      <AgentSurface layout="page" projectId={null}/>
    </div>
  </ViewPage>;
}
