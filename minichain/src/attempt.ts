/** Runs a computation, returning undefined when it rejects its input with a RangeError or TypeError. */
export function tryCompute<Result>(computation: () => Result): Result | undefined {
  try {
    return computation();
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
}
