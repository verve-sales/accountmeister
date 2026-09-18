export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
export class NotFoundError extends DomainError {
  constructor(what = "Objekt") {
    // Bewusst identisch zur Berechtigungsverweigerung nach außen, um Metadatenleckage zu vermeiden (S01).
    super("NOT_FOUND", `${what} nicht gefunden oder keine Berechtigung.`, 404);
  }
}
export class ForbiddenError extends DomainError {
  constructor(message = "Keine Berechtigung für diese Aktion.") {
    super("FORBIDDEN", message, 403);
  }
}
export class ValidationError extends DomainError {
  constructor(message: string) {
    super("VALIDATION", message, 400);
  }
}
export class ConflictError extends DomainError {
  constructor(message = "Der Datensatz wurde inzwischen geändert. Bitte neu laden und vergleichen.") {
    super("CONFLICT", message, 409);
  }
}
export class TransitionError extends DomainError {
  constructor(message: string) {
    super("INVALID_TRANSITION", message, 422);
  }
}
