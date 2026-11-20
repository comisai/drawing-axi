// The closed set of error codes. Every error prints `message`, `code` and
// `usage` on stdout; a usage error exits 2 and any other error exits 1.

export type ErrorCode =
  | 'usage'
  | 'not_found'
  | 'not_pdf'
  | 'encrypted'
  | 'damaged'
  | 'unsupported'
  | 'too_large'
  | 'no_page'
  | 'unknown_layer'
  | 'scale_unknown'
  | 'exists'
  | 'timed_out'
  | 'output_too_large'
  | 'internal_error';

export type ErrorFields = Record<string, string | number>;

export class AxiError extends Error {
  readonly code: ErrorCode;
  readonly fields: ErrorFields;

  constructor(code: ErrorCode, message: string, fields: ErrorFields = {}) {
    super(message);
    this.name = 'AxiError';
    this.code = code;
    this.fields = fields;
  }

  get exitCode(): 1 | 2 {
    return this.code === 'usage' ? 2 : 1;
  }
}

export const usage = (message: string): AxiError =>
  new AxiError('usage', message);
