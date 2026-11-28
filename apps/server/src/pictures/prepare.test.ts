import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { cameraPicture, samplePicture } from '../test/pictures.js'
import { pictureUrl } from './address.js'
import { formatOf, PICTURE_SIZE, PictureError, preparePicture } from './prepare.js'

const pixel = async (image: Buffer, left: number, top: number) => {
  const { data } = await sharp(image).extract({ left, top, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true })
  return [...data.subarray(0, 3)]
}
const near = (color: number[], wanted: number[]) => color.every((value, index) => Math.abs(value - wanted[index]!) <= 12)

describe('making the picture that is served', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('makes a square JPEG of a %s, whatever its shape and size', async (format) => {
    const made = await preparePicture(await samplePicture({ format, width: 1600, height: 900 }))

    expect(formatOf(made)).toBe('jpeg')
    expect(await sharp(made).metadata()).toMatchObject({ format: 'jpeg', width: PICTURE_SIZE, height: PICTURE_SIZE })
    expect(made.length).toBeLessThan(100_000)
  })

  it('makes a small picture larger, so that every picture has the same size', async () => {
    const made = await preparePicture(await samplePicture({ width: 40, height: 60 }))

    expect(await sharp(made).metadata()).toMatchObject({ width: PICTURE_SIZE, height: PICTURE_SIZE })
  })

  it('leaves behind what the camera noted in the file: place, device and everything else', async () => {
    const upload = await cameraPicture()
    const before = await sharp(upload).metadata()
    expect(before.exif, 'the upload of this test carries camera data').toBeInstanceOf(Buffer)
    expect(upload.includes('Example Camera')).toBe(true)

    const made = await preparePicture(upload)

    const after = await sharp(made).metadata()
    expect(after.exif).toBeUndefined()
    expect(after.icc).toBeUndefined()
    expect(after.xmp).toBeUndefined()
    expect(made.includes('Example Camera')).toBe(false)
  })

  it('turns the picture the way the camera held it, since the note that says so is gone', async () => {
    // Left half red, right half blue, and the camera says: held on its side, turn it by 90 degrees.
    const halves = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#0000ff' } })
      .composite([{ input: { create: { width: 200, height: 400, channels: 3, background: '#ff0000' } }, left: 0, top: 0 }])
      .jpeg()
      .toBuffer()
    const sideways = await sharp(halves).withMetadata({ orientation: 6 }).jpeg().toBuffer()

    const upright = await preparePicture(halves)
    const turned = await preparePicture(sideways)

    expect(near(await pixel(upright, 50, 256), [255, 0, 0]), 'as taken: red is on the left').toBe(true)
    expect(near(await pixel(turned, 256, 50), [255, 0, 0]), 'turned: red is at the top').toBe(true)
    expect(near(await pixel(turned, 256, 460), [0, 0, 255]), 'turned: blue is at the bottom').toBe(true)
  })

  it('puts white behind a picture that is transparent', async () => {
    const transparent = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()

    expect(near(await pixel(await preparePicture(transparent), 100, 100), [255, 255, 255])).toBe(true)
  })

  it.each([
    ['a GIF', () => samplePicture({ format: 'gif' })],
    ['an SVG', async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')],
    ['a page', async () => Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['nothing', async () => Buffer.alloc(0)],
  ])('refuses %s without opening it: only JPEG, PNG and WebP are read', async (_name, upload) => {
    await expect(preparePicture(await upload())).rejects.toMatchObject({ reason: 'format' })
  })

  it('refuses a file that only begins like a picture', async () => {
    const jpeg = await samplePicture()
    const cut = jpeg.subarray(0, 40)
    const disguised = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<script>alert(1)</script>')])

    await expect(preparePicture(cut)).rejects.toBeInstanceOf(PictureError)
    await expect(preparePicture(disguised)).rejects.toMatchObject({ reason: 'unreadable' })
  })

  it('refuses a picture of more pixels than it opens, however small the file', async () => {
    const enormous = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer()
    expect(enormous.length).toBeLessThan(1024 * 1024)

    await expect(preparePicture(enormous)).rejects.toMatchObject({ reason: 'unreadable' })
  })

  it('gives a picture an address below the address of pforte', () => {
    expect(pictureUrl('https://id.example.com', 'abc')).toBe('https://id.example.com/pictures/abc')
  })
})
