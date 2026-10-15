/** Four characters per token: the same prompt-only estimate the webview displays. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}
