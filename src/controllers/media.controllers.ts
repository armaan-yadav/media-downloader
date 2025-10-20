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
 * Check if yt-dlp is installed
 */
async function checkYtDlpInstalled(): Promise<boolean> {
  try {
    await execAsync("yt-dlp --version");
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Check if FFmpeg is installed
 */
async function checkFFmpegInstalled(): Promise<boolean> {
  try {
    await execAsync("ffmpeg -version");
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get video/image info using yt-dlp without downloading
 */
async function getMediaInfo(url: string): Promise<YtDlpInfo | YtDlpInfo[]> {
  try {
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-playlist "${url}"`,
      { maxBuffer: 1024 * 1024 * 10 } // 10MB buffer
    );

    const lines = stdout.trim().split("\n");

    // Some platforms return multiple JSON objects (one per media item)
    if (lines.length > 1) {
      const infos = lines.map((line) => JSON.parse(line));
      return infos.map((info: any) => ({
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
    }

    const info = JSON.parse(stdout);

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
    const err = error as Error;
    console.error("yt-dlp error:", err.message);

    // Check if it's an image-only tweet
    if (err.message.includes("No video could be found")) {
      throw new AppError(
        "This post contains only images. Please use the image download endpoint or specify you want images.",
        400
      );
    }

    throw new AppError(
      "Failed to extract media info. The URL may be invalid or require authentication.",
      400
    );
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
    // First get the info
    const mediaInfo = await getMediaInfo(url);
    const info = Array.isArray(mediaInfo) ? mediaInfo[0] : mediaInfo;

    // Create a temporary unique filename
    const tempFilename = `temp_${crypto.randomBytes(8).toString("hex")}`;
    const outputTemplate = path.join(
      path.dirname(outputPath),
      `${tempFilename}.%(ext)s`
    );

    // Check if FFmpeg is available for merging
    const hasFFmpeg = await checkFFmpegInstalled();

    if (!hasFFmpeg) {
      console.warn(
        "FFmpeg not installed. Audio merging may not work properly."
      );
    }

    // Determine format selection based on media type
    let formatSelection: string;

    if (
      info &&
      (info.ext === "jpg" || info.ext === "png" || info.ext === "webp")
    ) {
      // For images
      formatSelection = "best";
    } else {
      // For videos - CRITICAL: merge video+audio for Instagram/social media
      if (hasFFmpeg) {
        // Best video with audio, prefer mp4
        formatSelection =
          "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
      } else {
        // Without FFmpeg, try to get format that already has audio
        formatSelection = "best[height<=1080]/best";
      }
    }

    const command = [
      "yt-dlp",
      `--format "${formatSelection}"`,
      hasFFmpeg ? "--merge-output-format mp4" : "", // Merge to mp4 if FFmpeg available
      "--no-playlist",
      "--no-warnings",
      `--output "${outputTemplate}"`,
      `"${url}"`,
    ]
      .filter(Boolean)
      .join(" ");

    console.log("Executing:", command);

    await execAsync(command, {
      maxBuffer: 1024 * 1024 * 100, // 100MB buffer for larger files
      timeout: 120000, // 2 minute timeout
    });

    // Find the downloaded file (extension might be different after merge)
    const dir = path.dirname(outputPath);
    const files = await readdir(dir);
    const downloadedFile = files.find((f) => f.startsWith(tempFilename));

    if (!downloadedFile) {
      throw new Error("Downloaded file not found");
    }

    const downloadedPath = path.join(dir, downloadedFile);

    if (!info) {
      throw new Error("Failed to retrieve media info");
    }

    return {
      filePath: downloadedPath,
      info,
    };
  } catch (error) {
    const err = error as Error;
    console.error("Download error:", err.message);

    // Provide more specific error messages
    if (err.message.includes("No video could be found")) {
      throw new AppError("This post contains only images, not videos", 400);
    }

    throw new AppError(`Failed to download media: ${err.message}`, 502);
  }
}

/**
 * Download images from posts (for X.com tweets with only images)
 */
async function downloadImagesFromPost(
  url: string,
  outputDir: string
): Promise<{ filePaths: string[]; info: { type: string; count: number } }> {
  try {
    const tempFilename = `temp_${crypto.randomBytes(8).toString("hex")}`;
    const outputTemplate = path.join(
      outputDir,
      `${tempFilename}_%(autonumber)s.%(ext)s`
    );

    // Download all images from the post
    const command = [
      "yt-dlp",
      "--format best",
      "--write-thumbnail",
      "--skip-download", // Skip video, only get images
      `--output "${outputTemplate}"`,
      `"${url}"`,
    ].join(" ");

    console.log("Downloading images with:", command);

    // First try to get images using --write-thumbnail
    try {
      await execAsync(command, {
        maxBuffer: 1024 * 1024 * 50,
        timeout: 60000,
      });
    } catch (err) {
      // If that fails, try direct extraction
      console.log("Thumbnail method failed, trying direct image extraction");

      const altCommand = [
        "yt-dlp",
        "--no-video",
        "--write-thumbnail",
        "--convert-thumbnails jpg",
        `--output "${outputTemplate}"`,
        `"${url}"`,
      ].join(" ");

      await execAsync(altCommand, {
        maxBuffer: 1024 * 1024 * 50,
        timeout: 60000,
      });
    }

    // Find downloaded files
    const files = await readdir(outputDir);
    const downloadedFiles = files.filter((f) => f.startsWith(tempFilename));

    if (downloadedFiles.length === 0) {
      throw new Error("No images found in post");
    }

    const filePaths = downloadedFiles.map((f) => path.join(outputDir, f));

    return {
      filePaths,
      info: { type: "images", count: filePaths.length },
    };
  } catch (error) {
    const err = error as Error;
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
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "*/*",
    Referer: url,
  };

  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new AppError(`Failed to download: ${res.status}`, 502);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = res.headers.get("content-type");

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
  const { url, useYtDlp = true, downloadImages = false } = req.body;

  if (!url) {
    throw new AppError("URL is required", 400);
  }

  // Ensure media directory exists
  const mediaDir = path.join(process.cwd(), "public", "media");
  if (!existsSync(mediaDir)) {
    await mkdir(mediaDir, { recursive: true });
  }

  let filename: string;
  let filePath: string;
  let mediaType: "video" | "image";
  let fileSize: number;
  let info: Partial<YtDlpInfo> = {};

  // Try yt-dlp first if enabled and available
  if (useYtDlp) {
    const ytDlpAvailable = await checkYtDlpInstalled();

    if (!ytDlpAvailable) {
      console.warn("yt-dlp not installed, falling back to direct download");
    } else {
      try {
        console.log("Using yt-dlp to download:", url);

        const tempPath = path.join(mediaDir, "temp");

        // Try to download video first
        let result: { filePath: string; info: YtDlpInfo } | undefined;
        try {
          result = await downloadWithYtDlp(url, tempPath, !downloadImages);
        } catch (videoError) {
          const err = videoError as Error;
          // If video download fails due to "no video found", try downloading images
          if (err.message.includes("only images") || downloadImages) {
            console.log("Attempting to download images instead...");
            const imageResult = await downloadImagesFromPost(url, mediaDir);

            // For multiple images, return the first one (or handle multiple)
            if (imageResult.filePaths.length > 0) {
              const firstImage = imageResult.filePaths[0];
              if (!firstImage) {
                throw new Error("No valid image path found");
              }
              const ext = path.extname(firstImage);
              filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
              filePath = path.join(mediaDir, filename);

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

        // Move from temp location to final location
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

        console.log(
          `Successfully downloaded with yt-dlp: ${filename} (${fileSize} bytes)`
        );

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
        console.error("yt-dlp failed:", err.message);
        console.log("Falling back to direct download...");
      }
    }
  }

  // Fallback to direct download
  try {
    console.log("Using direct download:", url);

    const { buffer, contentType } = await directDownload(url);

    if (buffer.length === 0) {
      throw new AppError("Downloaded file is empty", 502);
    }

    const ext = getExtensionFromContentType(contentType);
    filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
    filePath = path.join(mediaDir, filename);

    await writeFile(filePath, buffer);

    fileSize = buffer.length;
    mediaType =
      contentType && contentType.startsWith("video") ? "video" : "image";

    console.log(
      `Successfully downloaded directly: ${filename} (${fileSize} bytes)`
    );

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
    console.error("Direct download failed:", err.message);
    throw new AppError(
      `Failed to download media. Both yt-dlp and direct download methods failed. ${err.message}`,
      502
    );
  }
});
