export type ProviderKind = "anthropic" | "openai" | "demo";

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface PublicProvider extends Omit<Provider, "apiKey"> {
  hasKey: boolean;
}

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: "short" | "long" | "bun" | "cap" | "bald" | "curly";
  shirt: string;
  pants: string;
  accessory?: "none" | "glasses" | "headphones";
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  prompt: string;
  providerId: string;
  model: string;
  appearance: Appearance;
  seat: number;
  lead?: boolean;
  tools?: boolean;
  look?: Look;
}

export interface Look {
  src: string;
  description: string;
  createdAt: number;
}

export interface Seat {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  background: string;
  width: number;
  height: number;
  entry: Seat;
  seats: Seat[];
  lights?: Seat[];
  board?: Rect;
  spots?: Seat[];
}

export interface Settings {
  workspace: string;
  autoApprove: boolean;
  imageProviderId?: string;
  imageModel?: string;
}

export interface Office {
  name: string;
  agents: Agent[];
  providers: Provider[];
  layout: Layout;
  settings?: Settings;
}

export interface PublicOffice extends Omit<Office, "providers"> {
  providers: PublicProvider[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Assignment {
  agentId: string;
  task: string;
}

export type ToolName = "list_dir" | "read_file" | "search" | "write_file" | "edit_file" | "run_command";

export type PermissionDecision = "allow" | "always" | "deny";

export type OfficeEvent =
  | { type: "run_start"; runId: string; text: string; target: string | null }
  | { type: "routing"; runId: string; leadId: string }
  | { type: "route"; runId: string; leadId: string; note: string; assignments: Assignment[] }
  | { type: "agent_start"; runId: string; agentId: string; task: string; from: string | null }
  | { type: "delta"; runId: string; agentId: string; text: string }
  | { type: "agent_done"; runId: string; agentId: string; text: string; tokens: number }
  | { type: "agent_error"; runId: string; agentId: string; error: string }
  | { type: "tool_call"; runId: string; agentId: string; callId: string; name: ToolName; args: Record<string, unknown>; summary: string }
  | { type: "permission_request"; runId: string; agentId: string; callId: string; name: ToolName; args: Record<string, unknown>; summary: string }
  | { type: "permission_resolved"; runId: string; agentId: string; callId: string; decision: PermissionDecision }
  | { type: "tool_result"; runId: string; agentId: string; callId: string; ok: boolean; output: string }
  | { type: "look_progress"; agentId: string; status: "drawing" | "done" | "error"; error?: string }
  | { type: "run_done"; runId: string }
  | { type: "office"; office: PublicOffice };
