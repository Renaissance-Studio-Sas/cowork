"use client";

import { useCallback, useState, useRef, type ReactNode, type DragEvent, type ClipboardEvent } from "react";

export interface FileAttachment {
  file: File;
  preview?: string; // data URL for images
  id: string;
}

interface Props {
  onFiles: (files: FileAttachment[]) => void;
  children: ReactNode;
  accept?: string;
  maxSize?: number; // bytes, default 10MB
  disabled?: boolean;
  className?: string;
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

async function createPreview(file: File): Promise<string | undefined> {
  if (!isImageFile(file)) return undefined;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

export function FileDropZone({
  onFiles,
  children,
  accept,
  maxSize = DEFAULT_MAX_SIZE,
  disabled = false,
  className = "",
}: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const processFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      const attachments: FileAttachment[] = [];

      for (const file of files) {
        // Check file size
        if (file.size > maxSize) {
          console.warn(`File ${file.name} exceeds max size of ${maxSize / 1024 / 1024}MB`);
          continue;
        }

        // Check file type if accept is specified
        if (accept) {
          const acceptedTypes = accept.split(",").map((t) => t.trim());
          const isAccepted = acceptedTypes.some((type) => {
            if (type.startsWith(".")) {
              return file.name.toLowerCase().endsWith(type.toLowerCase());
            }
            if (type.endsWith("/*")) {
              return file.type.startsWith(type.slice(0, -1));
            }
            return file.type === type;
          });
          if (!isAccepted) {
            console.warn(`File ${file.name} type ${file.type} not accepted`);
            continue;
          }
        }

        const preview = await createPreview(file);
        attachments.push({ file, preview, id: generateId() });
      }

      if (attachments.length > 0) {
        onFiles(attachments);
      }
    },
    [onFiles, accept, maxSize]
  );

  const handleDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      dragCounter.current++;
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        setIsDragging(true);
      }
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter.current = 0;

      if (disabled) return;

      const { files } = e.dataTransfer;
      if (files && files.length > 0) {
        processFiles(files);
      }
    },
    [disabled, processFiles]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (disabled) return;

      const { items } = e.clipboardData;
      const files: File[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        processFiles(files);
      }
    },
    [disabled, processFiles]
  );

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
      className={`${className} ${isDragging ? "file-drop-active" : ""}`}
      style={{
        position: "relative",
      }}
    >
      {children}
      {isDragging && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(37, 99, 235, 0.1)",
            border: "2px dashed var(--accent)",
            borderRadius: "inherit",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div
            style={{
              background: "var(--panel)",
              padding: "8px 16px",
              borderRadius: "8px",
              fontSize: "13px",
              color: "var(--accent)",
              fontWeight: 500,
            }}
          >
            Drop files here
          </div>
        </div>
      )}
    </div>
  );
}

// Preview component for displaying attached files
interface AttachmentPreviewProps {
  attachments: FileAttachment[];
  onRemove: (id: string) => void;
  compact?: boolean;
}

export function AttachmentPreview({ attachments, onRemove, compact = false }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  const size = compact ? 48 : 64;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: compact ? "6px" : "8px",
        padding: compact ? "6px 0" : "8px 0",
      }}
    >
      {attachments.map((att) => (
        <div
          key={att.id}
          style={{
            position: "relative",
            width: size,
            height: size,
            borderRadius: "8px",
            overflow: "hidden",
            border: "1px solid var(--border)",
            background: "var(--panel)",
          }}
        >
          {att.preview ? (
            <img
              src={att.preview}
              alt={att.file.name}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "4px",
              }}
            >
              <svg
                width={compact ? 16 : 20}
                height={compact ? 16 : 20}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ color: "var(--muted)" }}
              >
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
              <span
                style={{
                  fontSize: compact ? "8px" : "9px",
                  color: "var(--muted)",
                  marginTop: "2px",
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textAlign: "center",
                }}
              >
                {att.file.name.split(".").pop()?.toUpperCase() || "FILE"}
              </span>
            </div>
          )}
          <button
            onClick={() => onRemove(att.id)}
            style={{
              position: "absolute",
              top: "-4px",
              right: "-4px",
              width: compact ? "16px" : "18px",
              height: compact ? "16px" : "18px",
              borderRadius: "50%",
              background: "var(--text)",
              color: "var(--bg)",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: compact ? "10px" : "12px",
              fontWeight: "bold",
              lineHeight: 1,
            }}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
