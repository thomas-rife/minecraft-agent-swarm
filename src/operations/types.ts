export type OperationStatus = "succeeded" | "partial" | "failed" | "cancelled" | "timed_out";

export interface PostconditionResult {
  name: string;
  satisfied: boolean;
  evidence?: unknown;
}

export interface OperationProgress {
  [key: string]: number | string | boolean;
}

export interface OperationResult {
  status: OperationStatus;
  code: string;
  /** Human-readable display text. Control flow must never parse this field. */
  message: string;
  retryable: boolean;
  worldChanged: boolean;
  observations?: Record<string, unknown>;
  progress?: OperationProgress;
  postconditions: PostconditionResult[];
  operationId?: string;
  startedAt?: number;
  endedAt?: number;
}

export function operationResult(
  status: OperationStatus,
  code: string,
  message: string,
  options: Partial<Omit<OperationResult, "status" | "code" | "message">> = {},
): OperationResult {
  return {
    status,
    code,
    message,
    retryable: options.retryable ?? status === "failed",
    worldChanged: options.worldChanged ?? false,
    postconditions: options.postconditions ?? [],
    ...options,
  };
}

export function succeeded(
  code: string,
  message: string,
  options: Partial<Omit<OperationResult, "status" | "code" | "message">> = {},
): OperationResult {
  return operationResult("succeeded", code, message, { worldChanged: true, ...options });
}

export function failed(
  code: string,
  message: string,
  options: Partial<Omit<OperationResult, "status" | "code" | "message">> = {},
): OperationResult {
  return operationResult("failed", code, message, options);
}

export function partial(
  code: string,
  message: string,
  options: Partial<Omit<OperationResult, "status" | "code" | "message">> = {},
): OperationResult {
  return operationResult("partial", code, message, { worldChanged: true, ...options });
}

