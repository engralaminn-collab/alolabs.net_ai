import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/api-auth';
import { writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const UPLOAD_DIR = path.join(process.cwd(), 'storage', 'uploads');

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth();
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    if (file.size === 0) {
      return NextResponse.json({ error: 'file is empty' }, { status: 400 });
    }

    // Generate a unique file name to avoid collisions
    const ext = path.extname(file.name) || '';
    const baseName = path.basename(file.name, ext);
    const uniqueSuffix = crypto.randomBytes(8).toString('hex');
    const safeBaseName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const uniqueFileName = `${safeBaseName}_${uniqueSuffix}${ext}`;
    const filePath = path.join(UPLOAD_DIR, uniqueFileName);

    // Read file buffer and write to disk
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    await writeFile(filePath, buffer);

    // Create File record in database
    const fileRecord = await db.file.create({
      data: {
        name: file.name,
        path: `storage/uploads/${uniqueFileName}`,
        size: file.size,
        mimeType: file.type || null,
        category: detectCategory(file.name),
        uploadedBy: user.userId,
      },
    });

    // Create ProjectUpload record in database
    const projectUpload = await db.projectUpload.create({
      data: {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || null,
        storedPath: `storage/uploads/${uniqueFileName}`,
        uploadedBy: user.userId,
        status: 'stored',
      },
    });

    await db.auditLog.create({
      data: {
        userId: user.userId,
        action: 'upload',
        resource: 'uploads',
        details: JSON.stringify({
          fileId: fileRecord.id,
          uploadId: projectUpload.id,
          fileName: file.name,
          size: file.size,
          mimeType: file.type,
        }),
      },
    });

    return NextResponse.json({
      id: fileRecord.id,
      fileName: file.name,
      size: file.size,
      path: `storage/uploads/${uniqueFileName}`,
    }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Uploads POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function detectCategory(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'];
  const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
  const audioExts = ['.mp3', '.wav', '.ogg', '.flac', '.aac'];
  const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv'];
  const codeExts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.html', '.css', '.yaml', '.yml'];

  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (docExts.includes(ext)) return 'document';
  if (codeExts.includes(ext)) return 'code';
  return 'other';
}