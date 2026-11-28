/** Where pictures are served. */
export const PICTURES_PATH = '/pictures'

/** The address of a picture: what applications get as the claim `picture`. `key` is the random part (`users.pictureKey`). */
export const pictureUrl = (issuer: string, key: string) => `${issuer}${PICTURES_PATH}/${key}`
