import type { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/AppError.js";

/**
 * Global error handling middleware
 * Should be placed after all routes in your Express app
 */
export const errorMiddleware = (
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Default to 500 Internal Server Error
  let statusCode = 500;
  let message = "Internal Server Error";
  let isOperational = false;

  // If it's our custom AppError
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    isOperational = err.isOperational;
  } else if (err.message) {
    // Use the error message if available
    message = err.message;
  }

  // Log error for debugging
  console.error("Error:", {
    message: err.message,
    stack: err.stack,
    statusCode,
  });

  // Send error response
  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === "development" && {
      stack: err.stack,
      error: err,
    }),
  });
};
