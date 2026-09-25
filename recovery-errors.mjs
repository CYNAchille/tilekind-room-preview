// Public errors are selected from this allowlist; provider text is never exposed.
const ERRORS = Object.freeze({
  not_configured: ['AI is not configured. Set your provider credentials and model in the local server environment.', 'unavailable', 'not_started'],
  local_busy: ['One image is already generating. Wait or cancel it first.', 'wait', 'not_started', 3000],
  rate_limit: ['The image service is busy. Wait before trying the saved design as a new attempt.', 'retry_generation', 'not_started', 10000],
  authentication: ['The local image service could not authenticate. Check its connection and credentials before trying again.', 'unavailable', 'not_started'],
  quota_exceeded: ['The image service has no available quota. Check its account allowance before trying again.', 'unavailable', 'not_started'],
  invalid_input: ['The image service could not accept this design. Review the photo and selected surfaces.', 'change_input', 'not_started'],
  content_rejected: ['The image service could not process this photo or design under its content rules. Choose another photo or revise the design.', 'change_input', 'not_started'],
  timeout: ['The image connection timed out. The request may have run. Check this job before starting another attempt.', 'reconnect', 'uncertain'],
  network_disconnected: ['The image connection was interrupted. The request may have run. Check this job before starting another attempt.', 'reconnect', 'uncertain'],
  proxy_unavailable: ['The local image service could not be reached. Start it before retrying the saved design.', 'retry_generation', 'not_started'],
  provider_unavailable: ['The image service returned a server error. Its execution state is unknown. Check this job before starting another attempt.', 'reconnect', 'uncertain'],
  provider_error: ['The image service could not finish this request. Check the service before starting another attempt.', 'unavailable', 'started'],
  incomplete_output: ['The image service finished without a usable final image. You can retry the saved design as a new attempt.', 'retry_generation', 'started'],
  invalid_image: ['The image service returned an invalid or unsupported image. You can retry the saved design as a new attempt.', 'retry_generation', 'output_received'],
  cancelled: ['Local processing was cancelled. Work already sent to the image service may still have run.', 'reconnect', 'uncertain'],
  interrupted: ['The local server restarted before this job was confirmed complete. Its execution state is unknown; it was not sent again.', 'reconnect', 'uncertain'],
  result_processing: ['The image was received, but local result processing failed. Reload the saved result when available.', 'retry_result', 'output_received'],
  result_storage: ['The image was received, but could not be saved locally. Check local storage before starting another attempt.', 'unavailable', 'output_received'],
  request_storage: ['This request could not be recorded locally, so image generation did not start. Check local storage.', 'unavailable', 'not_started'],
  local_processing: ['The local editor could not prepare this photo and design. Check its image tools and selected assets.', 'unavailable', 'not_started'],
  request_conflict: ['This request ID belongs to a different submitted design. Check the original job or start an explicitly new attempt.', 'change_input', 'not_started'],
  request_not_found: ['No saved receipt was found for this request. Its submission state is unknown.', 'reconnect', 'uncertain'],
  job_not_found: ['No saved job was found. Check the request receipt before starting another attempt.', 'reconnect', 'uncertain'],
  history_unavailable: ['Saved request history could not be read safely. Check local storage before starting another attempt.', 'unavailable', 'uncertain'],
});

export class RecoveryError extends Error {
  constructor(errorCode, options = {}) {
    const [message, action, executionState, retryAfterMs] = ERRORS[errorCode] || ERRORS.provider_error;
    super(message);
    this.name = 'RecoveryError';
    this.errorCode = Object.hasOwn(ERRORS, errorCode) ? errorCode : 'provider_error';
    this.recovery = {
      action: options.action || action,
      retryAfterMs: Number.isFinite(options.retryAfterMs) ? Math.max(0, Math.round(options.retryAfterMs)) : (retryAfterMs ?? null),
      executionState: options.executionState || executionState,
    };
    if (Number.isInteger(options.httpStatus)) this.providerHttpStatus = options.httpStatus;
  }
}

export const recoveryError = (code, options) => new RecoveryError(code, options);
export const errorPayload = error => ({
  error: error.message,
  errorCode: error.errorCode,
  recovery: { ...error.recovery },
  ...(error.providerHttpStatus ? { providerHttpStatus: error.providerHttpStatus } : {}),
});

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
  // Never shorten a provider delay. Unrepresentable delays are left unavailable.
  return Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER ? Math.ceil(ms) : null;
}

export function providerError({ httpStatus, providerCode, providerType, retryAfterMs, terminal = false, executionState } = {}) {
  const codes = [providerCode, providerType].filter(value => typeof value === 'string').map(value => value.toLowerCase());
  const matches = pattern => codes.some(code => pattern.test(code));
  const options = { httpStatus, retryAfterMs, ...(executionState ? { executionState } : {}) };
  if (matches(/^(?:insufficient_quota|quota_exceeded|billing_hard_limit_reached|billing_limit_reached|credit_balance_too_low|usage_limit_reached)$/)) return recoveryError('quota_exceeded', options);
  if (matches(/^(?:content_policy_violation|content_filter|content_rejected|safety_violation|moderation_blocked|image_generation_user_error)$/)) return recoveryError('content_rejected', options);
  if ([401, 403].includes(httpStatus) || matches(/^(?:invalid_api_key|authentication_error|unauthorized|permission_denied)$/)) return recoveryError('authentication', options);
  if (httpStatus === 429 || matches(/^(?:rate_limit_exceeded|rate_limit_error|too_many_requests)$/)) return recoveryError('rate_limit', options);
  if (httpStatus === 408 || matches(/^(?:timeout|request_timeout)$/)) return recoveryError('timeout', { ...options, executionState: 'uncertain' });
  if ([400, 404, 413, 415, 422].includes(httpStatus) || matches(/^(?:invalid_request_error|invalid_input|invalid_value|invalid_image|image_too_large|unsupported_image)$/)) return recoveryError('invalid_input', options);
  if (httpStatus >= 500) return recoveryError('provider_unavailable', { ...options, executionState: 'uncertain' });
  if (matches(/^(?:incomplete_output|response_incomplete|failed_to_generate_image)$/)) return recoveryError('incomplete_output', { ...options, executionState: executionState || 'started' });
  return recoveryError('provider_error', { ...options, executionState: executionState || (httpStatus >= 400 ? 'not_started' : terminal ? 'started' : 'uncertain') });
}

