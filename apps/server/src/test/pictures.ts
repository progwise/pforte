import sharp from 'sharp'

/** A picture as a person would upload it: plain pixels of one colour, in the size and format asked for. */
export const samplePicture = ({ width = 800, height = 600, format = 'jpeg' as 'jpeg' | 'png' | 'webp' | 'gif', color = '#3366cc' } = {}) =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .toFormat(format)
    .toBuffer()

/** What a camera adds to a file: where the picture was taken, with which device, and which way up it was held. */
export const cameraPicture = ({ orientation = 1 } = {}) =>
  sharp({ create: { width: 400, height: 200, channels: 3, background: '#cc3333' } })
    .withExif({ IFD0: { Make: 'Example Camera', Model: 'Model X' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 31/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '13/1 24/1 0/1' } })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer()
