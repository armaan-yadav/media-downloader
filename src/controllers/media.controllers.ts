import { exec } from "child_process";
import crypto from "crypto";
import type { Request, Response } from "express";
import { existsSync } from "fs";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const execAsync = promisify(exec);

interface YtDlpInfo {
  url: string;
  ext: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  filesize?: number;
  format_id?: string;
  width?: number;
  height?: number;
  _type?: string;
}

/**
 * Get full path to yt-dlp binary
 */
async function getYtDlpPath(): Promise<string> {
  try {
    const { stdout } = await execAsync("which yt-dlp");
    const ytDlpPath = stdout.trim();
    console.log("[DEBUG] yt-dlp path:", ytDlpPath);
    return ytDlpPath;
  } catch (error) {
    console.log("[DEBUG] 'which yt-dlp' failed, trying direct command");
    return "yt-dlp"; // fallback to PATH
  }
}

/**
 * Check if yt-dlp is installed and log environment info
 */
async function checkYtDlpInstalled(): Promise<boolean> {
  try {
    console.log("[DEBUG] === Environment Check ===");
    console.log("[DEBUG] Current user:", process.env.USER || "unknown");
    console.log("[DEBUG] HOME:", process.env.HOME || "unknown");
    console.log("[DEBUG] PWD:", process.cwd());
    console.log("[DEBUG] PATH:", process.env.PATH);

    const ytDlpPath = await getYtDlpPath();

    console.log("[DEBUG] Checking yt-dlp installation...");
    const { stdout, stderr } = await execAsync(`${ytDlpPath} --version`, {
      env: process.env,
    });
    console.log("[DEBUG] yt-dlp version:", stdout.trim());

    if (stderr) {
      console.log("[DEBUG] yt-dlp version stderr:", stderr);
    }

    return true;
  } catch (error) {
    const err = error as any;
    console.error("[ERROR] yt-dlp not found or not accessible");
    console.error("[ERROR] Error:", err.message);
    console.error("[ERROR] stderr:", err.stderr);
    return false;
  }
}

/**
 * Check if FFmpeg is installed
 */
async function checkFFmpegInstalled(): Promise<boolean> {
  try {
    console.log("[DEBUG] Checking FFmpeg installation...");
    const { stdout } = await execAsync("ffmpeg -version");
    const version = stdout.split("\n")[0];
    console.log("[DEBUG] FFmpeg version:", version);
    return true;
  } catch (error) {
    const err = error as Error;
    console.error("[ERROR] FFmpeg not found:", err.message);
    return false;
  }
}

/**
 * Get video/image info using yt-dlp without downloading
 */
async function getMediaInfo(url: string): Promise<YtDlpInfo | YtDlpInfo[]> {
  try {
    console.log("[INFO] Fetching media info for:", url);

    const ytDlpPath = await getYtDlpPath();
    const command = `${ytDlpPath} --dump-json --no-playlist "${url}"`;
    console.log("[DEBUG] Executing command:", command);
    console.log("[DEBUG] Shell:", process.env.SHELL);

    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 1024 * 1024 * 10,
      timeout: 30000,
      env: {
        ...process.env,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
      cwd: process.cwd(),
    });

    if (stderr) {
      console.warn("[WARN] yt-dlp stderr:", stderr);

      // Check for specific errors
      if (stderr.includes("Sign in to confirm")) {
        throw new Error(
          "YouTube bot detection triggered. Try adding cookies or wait before retrying."
        );
      }
      if (stderr.includes("login required")) {
        throw new Error(
          "Login required for this platform. Use --cookies-from-browser option."
        );
      }
      if (stderr.includes("rate-limit")) {
        throw new Error("Rate limit reached. Please wait before trying again.");
      }
    }

    const lines = stdout.trim().split("\n");
    console.log("[DEBUG] Received", lines.length, "JSON object(s)");

    // Some platforms return multiple JSON objects (one per media item)
    if (lines.length > 1) {
      const infos = lines.map((line) => JSON.parse(line));
      const result = infos.map((info: any) => ({
        url: info.url,
        ext: info.ext,
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        filesize: info.filesize || info.filesize_approx,
        format_id: info.format_id,
        width: info.width,
        height: info.height,
        _type: info._type,
      }));
      console.log("[INFO] Extracted info for multiple media items");
      return result;
    }

    const info = JSON.parse(stdout);
    console.log("[INFO] Media info extracted:", {
      title: info.title,
      ext: info.ext,
      duration: info.duration,
      filesize: info.filesize || info.filesize_approx,
    });

    return {
      url: info.url,
      ext: info.ext,
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      filesize: info.filesize || info.filesize_approx,
      format_id: info.format_id,
      width: info.width,
      height: info.height,
      _type: info._type,
    };
  } catch (error) {
    const err = error as any;
    console.error("[ERROR] Failed to get media info");
    console.error("[ERROR] Error message:", err.message);
    console.error("[ERROR] Error code:", err.code);
    console.error("[ERROR] Command:", err.cmd);

    // Only log last 5 lines of stderr to avoid clutter
    if (err.stderr) {
      const stderrLines = err.stderr
        .split("\n")
        .filter((line: string) => line.trim());
      const lastLines = stderrLines.slice(-5);
      console.error(
        "[ERROR] yt-dlp stderr (last 5 lines):",
        lastLines.join("\n")
      );
    }

    // Check if it's an image-only tweet
    if (err.message.includes("No video could be found")) {
      throw new AppError(
        "This post contains only images. Please use the image download endpoint or specify you want images.",
        400
      );
    }

    throw new AppError(`Failed to extract media info: ${err.message}`, 400);
  }
}

/**
 * Download media using yt-dlp
 */
async function downloadWithYtDlp(
  url: string,
  outputPath: string,
  preferVideo: boolean = true
): Promise<{ filePath: string; info: YtDlpInfo }> {
  try {
    console.log("[INFO] Starting yt-dlp download for:", url);

    // First get the info
    const mediaInfo = await getMediaInfo(url);
    const info = Array.isArray(mediaInfo) ? mediaInfo[0] : mediaInfo;

    // Create a temporary unique filename
    const tempFilename = `temp_${crypto.randomBytes(8).toString("hex")}`;
    const outputDir = path.dirname(outputPath);
    const outputTemplate = path.join(outputDir, `${tempFilename}.%(ext)s`);

    console.log("[DEBUG] Temp filename:", tempFilename);
    console.log("[DEBUG] Output directory:", outputDir);
    console.log("[DEBUG] Output template:", outputTemplate);

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      console.log("[INFO] Creating output directory:", outputDir);
      await mkdir(outputDir, { recursive: true });
    }

    // Check permissions
    try {
      await writeFile(path.join(outputDir, ".test"), "test");
      await unlink(path.join(outputDir, ".test"));
      console.log("[DEBUG] Write permissions OK for:", outputDir);
    } catch (permErr) {
      console.error("[ERROR] No write permission for:", outputDir);
      throw new Error(`No write permission for output directory: ${outputDir}`);
    }

    // Check if FFmpeg is available for merging
    const hasFFmpeg = await checkFFmpegInstalled();

    if (!hasFFmpeg) {
      console.warn(
        "[WARN] FFmpeg not installed. Audio merging may not work properly."
      );
    }

    // Determine format selection based on media type
    let formatSelection: string;

    if (
      info &&
      (info.ext === "jpg" || info.ext === "png" || info.ext === "webp")
    ) {
      console.log("[INFO] Detected image format:", info.ext);
      formatSelection = "best";
    } else {
      console.log(
        "[INFO] Detected video format, selecting appropriate quality"
      );
      // For videos - merge video+audio for Instagram/social media
      if (hasFFmpeg) {
        formatSelection =
          "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
      } else {
        formatSelection = "best[height<=1080]/best";
      }
    }

    console.log("[DEBUG] Format selection:", formatSelection);

    const ytDlpPath = await getYtDlpPath();

    const command = [
      ytDlpPath,
      `--format "${formatSelection}"`,
      hasFFmpeg ? "--merge-output-format mp4" : "",
      "--no-playlist",
      "--no-warnings",
      "--newline", // Show progress on new lines (better for logging)
      `--output "${outputTemplate}"`,
      `"${url}"`,
    ]
      .filter(Boolean)
      .join(" ");

    console.log("[INFO] Executing download command");
    console.log("[DEBUG] Full command:", command);

    const startTime = Date.now();
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 1024 * 1024 * 100,
      timeout: 120000,
      env: {
        ...process.env,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
      cwd: outputDir, // Run from output directory
    });
    const duration = Date.now() - startTime;

    console.log("[INFO] Download completed in", duration, "ms");

    if (stdout) {
      const stdoutLines = stdout.split("\n").filter((line) => line.trim());
      console.log(
        "[DEBUG] yt-dlp output (last 5 lines):",
        stdoutLines.slice(-5).join("\n")
      );
    }

    if (stderr) {
      const stderrLines = stderr
        .split("\n")
        .filter((line) => line.trim() && line.includes("ERROR"));
      if (stderrLines.length > 0) {
        console.warn("[WARN] yt-dlp errors:", stderrLines.join("\n"));
      }
    }

    // Find the downloaded file (extension might be different after merge)
    const files = await readdir(outputDir);
    console.log("[DEBUG] Looking for files starting with:", tempFilename);
    console.log(
      "[DEBUG] Files in directory:",
      files.filter((f) => f.startsWith(tempFilename))
    );

    const downloadedFile = files.find((f) => f.startsWith(tempFilename));

    if (!downloadedFile) {
      console.error("[ERROR] Downloaded file not found!");
      console.error("[ERROR] Expected prefix:", tempFilename);
      console.error("[ERROR] All files in directory:", files);
      throw new Error("Downloaded file not found in output directory");
    }

    const downloadedPath = path.join(outputDir, downloadedFile);
    console.log("[INFO] Downloaded file found:", downloadedPath);

    const fileStats = await stat(downloadedPath);
    console.log("[INFO] File size:", fileStats.size, "bytes");

    if (fileStats.size === 0) {
      throw new Error("Downloaded file is empty (0 bytes)");
    }

    if (!info) {
      throw new Error("Failed to retrieve media info");
    }

    return {
      filePath: downloadedPath,
      info,
    };
  } catch (error) {
    const err = error as any;
    console.error("[ERROR] Download failed");
    console.error("[ERROR] Error message:", err.message);
    console.error("[ERROR] Error code:", err.code);

    if (err.stderr) {
      const stderrLines = err.stderr
        .split("\n")
        .filter((line: string) => line.trim());
      console.error(
        "[ERROR] stderr (last 10 lines):",
        stderrLines.slice(-10).join("\n")
      );
    }

    // Provide more specific error messages
    if (err.message.includes("No video could be found")) {
      throw new AppError("This post contains only images, not videos", 400);
    }

    if (err.stderr && err.stderr.includes("bot")) {
      throw new AppError(
        "Bot detection triggered. Please wait a few minutes before retrying.",
        429
      );
    }

    throw new AppError(`Failed to download media: ${err.message}`, 502);
  }
}

/**
 * Download images from posts
 */
async function downloadImagesFromPost(
  url: string,
  outputDir: string
): Promise<{ filePaths: string[]; info: { type: string; count: number } }> {
  try {
    console.log("[INFO] Downloading images from post:", url);

    const tempFilename = `temp_${crypto.randomBytes(8).toString("hex")}`;
    const outputTemplate = path.join(
      outputDir,
      `${tempFilename}_%(autonumber)s.%(ext)s`
    );

    console.log("[DEBUG] Image temp filename:", tempFilename);

    const ytDlpPath = await getYtDlpPath();

    // Download all images from the post
    const command = [
      ytDlpPath,
      "--format best",
      "--write-thumbnail",
      "--skip-download",
      `--output "${outputTemplate}"`,
      `"${url}"`,
    ].join(" ");

    console.log("[INFO] Downloading images");

    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 1024 * 1024 * 50,
        timeout: 60000,
        env: process.env,
        cwd: outputDir,
      });
      if (stdout)
        console.log("[DEBUG] Image download output:", stdout.slice(-200));
    } catch (err) {
      console.log(
        "[WARN] Thumbnail method failed, trying direct image extraction"
      );

      const altCommand = [
        ytDlpPath,
        "--no-video",
        "--write-thumbnail",
        "--convert-thumbnails jpg",
        `--output "${outputTemplate}"`,
        `"${url}"`,
      ].join(" ");

      const { stdout, stderr } = await execAsync(altCommand, {
        maxBuffer: 1024 * 1024 * 50,
        timeout: 60000,
        env: process.env,
        cwd: outputDir,
      });
      if (stdout)
        console.log("[DEBUG] Alt image download output:", stdout.slice(-200));
    }

    // Find downloaded files
    const files = await readdir(outputDir);
    const downloadedFiles = files.filter((f) => f.startsWith(tempFilename));

    console.log("[INFO] Found", downloadedFiles.length, "image file(s)");

    if (downloadedFiles.length === 0) {
      throw new Error("No images found in post");
    }

    const filePaths = downloadedFiles.map((f) => path.join(outputDir, f));

    return {
      filePaths,
      info: { type: "images", count: filePaths.length },
    };
  } catch (error) {
    const err = error as any;
    console.error("[ERROR] Image download failed:", err.message);
    throw new AppError(`Failed to download images: ${err.message}`, 502);
  }
}

/**
 * Fallback method: direct download without yt-dlp
 */
async function directDownload(url: string): Promise<{
  buffer: Buffer;
  contentType: string | null;
}> {
  console.log("[INFO] Attempting direct download for:", url);

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "*/*",
    Referer: url,
  };

  const res = await fetch(url, { headers });

  console.log("[DEBUG] Response status:", res.status);
  const contentType = res.headers.get("content-type");
  console.log("[DEBUG] Content-Type:", contentType);

  if (!res.ok) {
    throw new AppError(
      `Failed to download: ${res.status} ${res.statusText}`,
      502
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  console.log(
    "[INFO] Direct download successful. Size:",
    buffer.length,
    "bytes"
  );

  return { buffer, contentType };
}

function getExtensionFromContentType(contentType: string | null): string {
  if (!contentType) return ".bin";

  const type = contentType.toLowerCase();
  if (type.includes("video/mp4")) return ".mp4";
  if (type.includes("video/quicktime")) return ".mov";
  if (type.includes("video/webm")) return ".webm";
  if (type.includes("video")) return ".mp4";
  if (type.includes("image/jpeg")) return ".jpg";
  if (type.includes("image/png")) return ".png";
  if (type.includes("image/gif")) return ".gif";
  if (type.includes("image/webp")) return ".webp";
  if (type.includes("image")) return ".jpg";

  return ".bin";
}

export const fetchMedia = asyncHandler(async (req: Request, res: Response) => {
  console.log("\n========================================");
  console.log("[REQUEST] New media download request");
  console.log("[REQUEST] Body:", JSON.stringify(req.body, null, 2));
  console.log("========================================\n");

  const { url, useYtDlp = true, downloadImages = false } = req.body;

  if (!url) {
    throw new AppError("URL is required", 400);
  }

  // Ensure media directory exists
  const mediaDir = path.join(process.cwd(), "public", "media");
  console.log("[DEBUG] Media directory:", mediaDir);

  if (!existsSync(mediaDir)) {
    console.log("[INFO] Creating media directory...");
    await mkdir(mediaDir, { recursive: true });
  }

  let filename: string;
  let filePath: string;
  let mediaType: "video" | "image";
  let fileSize: number;
  let info: Partial<YtDlpInfo> = {};

  // Try yt-dlp first if enabled and available
  if (useYtDlp) {
    console.log("[INFO] Attempting yt-dlp download (useYtDlp=true)");
    const ytDlpAvailable = await checkYtDlpInstalled();

    if (!ytDlpAvailable) {
      console.warn(
        "[WARN] yt-dlp not installed, falling back to direct download"
      );
    } else {
      try {
        console.log("[INFO] yt-dlp is available, proceeding with download");
        console.log("[INFO] Target URL:", url);

        const tempPath = path.join(mediaDir, "temp");

        // Try to download video first
        let result: { filePath: string; info: YtDlpInfo } | undefined;
        try {
          result = await downloadWithYtDlp(url, tempPath, !downloadImages);
        } catch (videoError) {
          const err = videoError as Error;
          console.error("[ERROR] Video download failed:", err.message);

          // If video download fails due to "no video found", try downloading images
          if (err.message.includes("only images") || downloadImages) {
            console.log("[INFO] Attempting to download images instead...");
            const imageResult = await downloadImagesFromPost(url, mediaDir);

            if (imageResult.filePaths.length > 0) {
              const firstImage = imageResult.filePaths[0];
              if (!firstImage) {
                throw new Error("No valid image path found");
              }
              const ext = path.extname(firstImage);
              filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
              filePath = path.join(mediaDir, filename);

              console.log("[INFO] Renaming image to final filename:", filename);
              await rename(firstImage, filePath);

              // Clean up other temp files
              for (let i = 1; i < imageResult.filePaths.length; i++) {
                const imagePath = imageResult.filePaths[i];
                if (imagePath) {
                  await unlink(imagePath).catch(() => {});
                }
              }

              const stats = await stat(filePath);
              fileSize = stats.size;
              mediaType = "image";

              console.log("[SUCCESS] Image downloaded successfully\n");

              return res.json({
                success: true,
                message: "Image downloaded successfully",
                filename,
                mediaUrl: `/media/${filename}`,
                mediaType,
                size: fileSize,
                method: "yt-dlp-image",
                info: {
                  title: "Post Image",
                  count: imageResult.info.count,
                },
              });
            }
          }
          throw videoError;
        }

        // Generate final filename
        const ext = path.extname(result.filePath);
        filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
        filePath = path.join(mediaDir, filename);

        console.log("[INFO] Moving file to final location:", filename);
        await rename(result.filePath, filePath);

        // Get file stats
        const stats = await stat(filePath);
        fileSize = stats.size;

        // Determine media type
        mediaType = ["mp4", "mov", "webm", "avi", "mkv"].includes(
          ext.slice(1).toLowerCase()
        )
          ? "video"
          : "image";

        info = result.info;

        console.log("[SUCCESS] Media downloaded successfully with yt-dlp");
        console.log("[SUCCESS] Filename:", filename);
        console.log("[SUCCESS] Type:", mediaType);
        console.log("[SUCCESS] Size:", fileSize, "bytes\n");

        return res.json({
          success: true,
          message: "Media downloaded successfully",
          filename,
          mediaUrl: `/media/${filename}`,
          mediaType,
          size: fileSize,
          method: "yt-dlp",
          info: {
            title: info.title,
            duration: info.duration,
            thumbnail: info.thumbnail,
            width: info.width,
            height: info.height,
          },
        });
      } catch (ytDlpError) {
        const err = ytDlpError as Error;
        console.error("[ERROR] yt-dlp completely failed:", err.message);
        console.error("[ERROR] Stack trace:", err.stack);
        console.log("[INFO] Falling back to direct download...\n");
      }
    }
  } else {
    console.log(
      "[INFO] yt-dlp disabled (useYtDlp=false), using direct download"
    );
  }

  // Fallback to direct download
  try {
    console.log("[INFO] Starting direct download method");

    const { buffer, contentType } = await directDownload(url);

    if (buffer.length === 0) {
      throw new AppError("Downloaded file is empty", 502);
    }

    const ext = getExtensionFromContentType(contentType);
    filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
    filePath = path.join(mediaDir, filename);

    console.log("[INFO] Writing file:", filename);
    await writeFile(filePath, buffer);

    fileSize = buffer.length;
    mediaType =
      contentType && contentType.startsWith("video") ? "video" : "image";

    console.log("[SUCCESS] Direct download successful");
    console.log("[SUCCESS] Filename:", filename);
    console.log("[SUCCESS] Type:", mediaType);
    console.log("[SUCCESS] Size:", fileSize, "bytes\n");

    return res.json({
      success: true,
      message: "Media downloaded successfully",
      filename,
      mediaUrl: `/media/${filename}`,
      mediaType,
      size: fileSize,
      method: "direct",
    });
  } catch (error) {
    const err = error as Error;
    console.error("[FATAL] All download methods failed");
    console.error("[FATAL] Final error:", err.message);
    console.error("[FATAL] Stack trace:", err.stack);
    throw new AppError(`Failed to download media. ${err.message}`, 502);
  }
});
