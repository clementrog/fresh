export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnprocessableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnprocessableError";
  }
}
