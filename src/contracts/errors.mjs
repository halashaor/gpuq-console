export class InvalidRequest extends Error {
  constructor(field) {
    super('INVALID_REQUEST');
    this.code = 'INVALID_REQUEST';
    this.field = field;
  }
}

export class InvalidResponse extends Error {
  constructor() {
    super('INVALID_API_RESPONSE');
    this.code = 'INVALID_API_RESPONSE';
  }
}
