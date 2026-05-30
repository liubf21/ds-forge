export interface ToolBlock {
  id: string;
  name: string;
  args: string;
  result?: string;
  running: boolean;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  tools: ToolBlock[];
}

export type HistoryMessage = UserMessage | AssistantMessage;

export interface LiveTurn {
  content: string;
  tools: ToolBlock[];
}
