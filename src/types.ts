export interface Notebook {
  id: string;
  title: string;
  emoji?: string;
  source_count?: number;
}

export interface Source {
  id: string;
  notebook_id: string;
  title?: string;
  type: "text" | "url" | "file" | "unknown";
  url?: string;
  created_at?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  answer: string;
  citations?: Citation[];
}

export interface Citation {
  source_id: string;
  text: string;
  start_index?: number;
  end_index?: number;
}

export interface AudioStatus {
  status: "pending" | "processing" | "completed" | "failed";
  audio_url?: string;
  transcript?: string;
}

export interface ApiError extends Error {
  status?: number;
  body?: string;
}
