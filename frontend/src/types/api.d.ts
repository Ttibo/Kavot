/** Shared data contracts returned by the local API. */
interface ProjectExternalResource { id: string; resource_type: 'url' | 'github' | 'overleaf' | 'local_path'; target: string; title: string; created_at?: string; }
interface Project { updated_at?: string; repository_path?: string; repository_context_enabled?: boolean; id: number; name: string; color: string; description?: string; status?: string; canvas_path?: string; manifest_path?: string; relations_path?: string; references_path?: string; uid?: string; note_count?: number; paper_count?: number; task_count?: number; external_resources?: ProjectExternalResource[]; }
interface Paper {
  favorite?: boolean;
  id: number; title: string; authors: string[]; doi: string; folder_id: number | null; folder_ids?: number[];
  created_at?: string; published_at?: string; publication?: string; abstract?: string;
  url?: string; file_path?: string | null; status?: string; tags: string[];
  projects: Project[]; metadata?: Record<string, any>; reference_count?: number;
  zotero_key?: string | null; openalex_id?: string | null; origin?: string;
}
interface PaperFolder { id: number; name: string; parent_id: number | null; }
interface PaperReference { id?: number; paper_id: number; matched_paper_id?: number | null; doi?: string; title?: string; raw_text?: string; authors?: string[]; year?: string; position?: number; }
interface Note { id: number; title: string; content: string; content_format?: 'html'; content_hash?: string; document_uid?: string; properties?: Record<string, any>; presentation?: Record<string, any>; paper_id: number | null; project_id: number | null; folder_id: number | null; template_id?: number | null; file_name?: string; trashed_at?: string | null; updated_at?: string; drawing?: Record<string, any> | null; drawing_preview?: string | null; }
interface NoteFolder { id: number; name: string; parent_id: number | null; project_id: number | null; color: string; default_template_id?: number | null; system_kind?: string; }
interface WorkspaceResource { type: string; path: string; title: string; url?: string; paperId?: number; content?: string | Record<string, any>; generated?: boolean; /** Version of the file this copy was read at (X-Kavot-Version). */ version?: string; }
interface Window { pywebview?: {platform?: string; state?: EventTarget & { maximized?: boolean }; api?: {minimize_window?: () => Promise<void>; toggle_maximize_window?: () => Promise<void>; close_window?: () => Promise<void>; move_window?: (anchor: number, offset: number) => Promise<boolean>; resize_window?: (edge: string) => Promise<boolean>; open_external_url?: (url: string) => Promise<boolean>; open_project_resource?: (target: string) => Promise<boolean>; pick_storage_folder?: () => Promise<string | null>; pick_project_resource_folder?: () => Promise<string | null>}}; }
