import {
  ModelOutputError,
  type GenerateInput,
  type GenerateResult,
  type ScalarModelProvider,
  type StructuredOutputResult,
} from '../provider.js';

/** One planned model turn. */
export type ScriptedTurn =
  | { type: 'text'; text: string }
  | { type: 'tools'; text?: string; calls: { id: string; name: string; input: unknown }[] }
  | { type: 'refusal'; category?: string; explanation?: string };

/**
 * A provider that replays a fixed script. Used by the test suite to exercise the command loop
 * deterministically, and available to self-hosters who want Scalar to run with AI features
 * visibly disabled rather than half working.
 */
export class ScriptedProvider implements ScalarModelProvider {
  readonly name = 'scripted';
  private readonly turns: ScriptedTurn[];
  private index = 0;
  /** Every request the loop made, for assertions. */
  readonly requests: GenerateInput[] = [];

  constructor(turns: ScriptedTurn[]) {
    this.turns = turns;
  }

  generate(input: GenerateInput): Promise<GenerateResult> {
    this.requests.push(input);
    const turn = this.turns[this.index];
    this.index += 1;
    if (!turn) {
      return Promise.reject(
        new Error('ScriptedProvider ran out of turns; the loop asked for more than expected'),
      );
    }
    const usage = { inputTokens: 10, outputTokens: 5 };
    if (turn.type === 'refusal') {
      return Promise.resolve({
        text: '',
        toolCalls: [],
        stopReason: 'refusal',
        refusal: { category: turn.category ?? 'cyber', explanation: turn.explanation ?? null },
        usage,
        model: 'scripted',
      });
    }
    if (turn.type === 'tools') {
      return Promise.resolve({
        text: turn.text ?? '',
        toolCalls: turn.calls,
        stopReason: 'tool_use',
        usage,
        model: 'scripted',
      });
    }
    return Promise.resolve({
      text: turn.text,
      toolCalls: [],
      stopReason: 'end_turn',
      usage,
      model: 'scripted',
    });
  }

  structuredOutput<T>(): Promise<StructuredOutputResult<T>> {
    return Promise.reject(
      new ModelOutputError('ScriptedProvider does not implement structuredOutput.'),
    );
  }
}
