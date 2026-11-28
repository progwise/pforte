import { customType, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './columns.js'
import { users } from './users.js'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

/**
 * The picture a person gave themselves on the account pages: one per person, as pforte serves it (a square JPEG
 * it made from what was uploaded; the upload itself is not kept).
 *
 * Apart from `users`, whose rows are read whole all over: the bytes are read in one place only, where the
 * picture is served. `users.pictureKey` names the row, so that everything that reads a person knows whether they
 * have a picture and what its address is.
 */
export const userPictures = pgTable('user_pictures', {
  /** The random part of the address the picture is served at. A new picture gets a new one. */
  key: text().primaryKey(),
  userId: uuid()
    .notNull()
    .unique('user_pictures_user_id_unique')
    .references(() => users.id, { onDelete: 'cascade' }),
  image: bytea().notNull(),
  ...timestamps(),
})
