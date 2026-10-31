import { ViewPage } from '../components/ViewLayout';
import { useRuntime } from '../app/runtime';
import { AgentSurface } from '../features/agents/AgentSurface';
import '../styles/features/chat.css';

/** The conversations with the agents: of every project, or of the project the sidebar is filtered on.
 * No view header: the tab already names the view, and the list column names the project it is filtered on. */
export function ChatView() {
  const runtime = useRuntime();
  const project = runtime.scopeProject();
  return <ViewPage className="chat-view" label="Agents">
    <div className="chat-layout">
      <AgentSurface key={project?.id ?? 'all'} layout="page" projectId={project?.id ?? null} scopeLabel={project?.name}/>
    </div>
  </ViewPage>;
}
