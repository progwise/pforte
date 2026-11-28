import sharp from 'sharp'

/** The picture pforte serves is a square of this many pixels a side. */
export const PICTURE_SIZE = 512
/** The largest file a person can upload. A photo straight from a phone fits. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
/** The largest picture that is opened at all, in pixels: a small file can claim to be an enormous picture. */
const MAX_PIXELS = 64_000_000
const TIMEOUT_SECONDS = 15

// One picture is worked on by one thread, and nothing is kept in memory between two: a person who uploads a
// picture must not slow down the people who sign in.
sharp.concurrency(1)
sharp.cache(false)

/** Why an upload did not become a picture: it is none of the formats pforte takes, or it could not be read as one. */
export class PictureError extends Error {
  constructor(readonly reason: 'format' | 'unreadable') {
    super(reason === 'format' ? 'The file is not a JPEG, PNG or WebP picture.' : 'The file could not be read as a picture.')
  }
}

const startsWith = (bytes: Buffer, signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte)

/**
 * What the first bytes say the file is. Asked before anything opens the file: the library that reads pictures
 * knows many more formats (SVG, GIF, TIFF and others), and none of their readers is to see a file from outside.
 */
export const formatOf = (bytes: Buffer): 'jpeg' | 'png' | 'webp' | undefined => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp'
  return undefined
}

/**
 * Makes the picture pforte serves from what a person uploaded: a square JPEG of `PICTURE_SIZE` pixels.
 *
 * Nothing of the upload is served as it came. The picture is read, turned the way its camera held it, cut to a
 * square around what stands out in it (a face, usually), made smaller and written anew. What a camera adds to a
 * file does not survive that: where and when the picture was taken, with which device, a preview of the uncut
 * picture. Nor does anything else a file can carry besides its pixels. A transparent background becomes white.
 *
 * Throws a `PictureError` for a file that is no JPEG, PNG or WebP, or that cannot be read as one.
 */
export const preparePicture = async (upload: Buffer): Promise<Buffer> => {
  const format = formatOf(upload)
  if (!format) throw new PictureError('format')
  try {
    const picture = sharp(upload, { limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1 })
    // The first bytes can say one thing and the file be another.
    if ((await picture.metadata()).format !== format) throw new PictureError('format')
    return await picture
      .autoOrient()
      .resize(PICTURE_SIZE, PICTURE_SIZE, { fit: 'cover', position: sharp.strategy.attention })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .timeout({ seconds: TIMEOUT_SECONDS })
      .toBuffer()
  } catch (error) {
    if (error instanceof PictureError) throw error
    throw new PictureError('unreadable')
  }
}
