-- Characters the owner creates from an uploaded photo: the photo is analysed once into the look parameters the code-drawn
-- chibi engine understands (no AI image generation); only a small thumbnail of the photo is kept.
CREATE TABLE IF NOT EXISTS characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  look jsonb NOT NULL,
  thumb text,                                   -- small JPEG data URL, for the picker
  created_at timestamptz NOT NULL DEFAULT now()
);
-- characters chosen for a draft (snapshot of name + look), forced into its cast
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS characters jsonb NOT NULL DEFAULT '[]'::jsonb;
