/**
 * Compile-stage errors. Each one says what is wrong and what to do; none is ever "fixed"
 * by guessing timings or adding filler.
 */

/** The alignment arrays themselves are broken (lengths, order, bounds, text mismatch). */
export class AlignmentValidationError extends Error {
  constructor(readonly sceneId: string, message: string) {
    super(`Scene "${sceneId}": invalid alignment: ${message}`);
    this.name = "AlignmentValidationError";
  }
}

/**
 * Text could not be mapped onto the spoken words with certainty (PIPELINE_DESIGN.md §6 step 7).
 * Recoverable: fix the speech/display mapping or retry speech.
 */
export class AlignmentMappingError extends Error {
  constructor(readonly sceneId: string, message: string) {
    super(`Scene "${sceneId}": ${message}`);
    this.name = "AlignmentMappingError";
  }
}

/** The compiled video is outside 60-90 s. The plan goes back for adjustment; no filler is added. */
export class DurationOutOfRangeError extends Error {
  constructor(readonly totalFrames: number, readonly minFrames: number, readonly maxFrames: number, readonly fps: number) {
    const seconds = (totalFrames / fps).toFixed(2);
    const direction = totalFrames < minFrames ? "too short: expand the explanation" : "too long: shorten the narration";
    super(
      `Compiled video is ${seconds} s (${totalFrames} frames) but must be ${minFrames / fps}-${maxFrames / fps} s ` +
        `(${minFrames}-${maxFrames} frames). It is ${direction}. Return the plan for adjustment and re-approval; ` +
        "no filler or padding is added.",
    );
    this.name = "DurationOutOfRangeError";
  }
}

/** Other invalid compile input (missing scene alignment, bad hold, event outside its scene). */
export class CompileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileInputError";
  }
}
