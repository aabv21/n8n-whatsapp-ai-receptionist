export interface AgentStep {
  action: { tool: string; toolInput: unknown };
  observation: unknown;
}

export interface ToolCall {
  tool: string;
  input: unknown;
  output: unknown;
}

function parseObservation(observation: unknown): unknown {
  if (typeof observation !== 'string') return observation;
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation);
  } catch {
    return observation;
  }
  // The AI Agent (v3) runs each tool as its own node and reports the JSON array of that node's
  // output items. Every sub-workflow tool here returns one item, and that item is the tool's result.
  return Array.isArray(parsed) && parsed.length === 1 ? (parsed[0] as unknown) : parsed;
}

export function run(input: { intermediateSteps?: AgentStep[] | null }): { tool_calls: ToolCall[] } {
  const steps = input.intermediateSteps ?? [];
  return {
    tool_calls: steps.map((step) => ({
      tool: step.action.tool,
      input: step.action.toolInput,
      output: parseObservation(step.observation),
    })),
  };
}
