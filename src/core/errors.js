export class AppError extends Error {
  constructor(code, message, action = null, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.action = action;
    this.status = status;
  }
}
