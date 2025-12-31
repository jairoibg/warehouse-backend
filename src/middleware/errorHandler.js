/**
 * Middleware centralizado para manejo de errores
 */

export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Recurso') {
    super(`${resource} no encontrado`, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'No autorizado') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * Middleware de manejo de errores global
 */
export function errorHandler(err, req, res, next) {
  // Si el error ya tiene statusCode, es un AppError
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'Error interno del servidor';

  // Log del error
  console.error(`[ERROR] ${code}: ${message}`, {
    statusCode,
    path: req.path,
    method: req.method,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });

  // Respuesta al cliente
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
}

/**
 * Wrapper para async routes (evita try/catch en cada route)
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Middleware de validación básica
 */
export function validateRequest(schema) {
  return (req, res, next) => {
    try {
      // Validación básica - puede extenderse con Joi/Zod
      if (schema.body) {
        for (const [key, validator] of Object.entries(schema.body)) {
          if (validator.required && !req.body[key]) {
            throw new ValidationError(`Campo requerido: ${key}`);
          }
        }
      }
      if (schema.query) {
        for (const [key, validator] of Object.entries(schema.query)) {
          if (validator.required && !req.query[key]) {
            throw new ValidationError(`Query param requerido: ${key}`);
          }
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}



