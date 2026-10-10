-- Names hold any language, symbol and emoji (owner, Oct 10, 2026). The server now counts a name's
-- limit in the characters a person sees (src/display-text.js): "👨‍👩‍👧‍👦" is one character there, but
-- seven to char_length, which counts code points, so an 80-character name of families would be
-- refused here. These checks keep their job as a backstop on size rather than on what a person
-- sees, at the same ceiling the server holds: ten code points for every character a name is
-- allowed. Only the limits widen; nothing is narrowed or renamed, so every stored row still passes
-- and the release before this one runs against it unchanged.
--
-- On real Postgres the column checks are named <table>_<column>_check and the moment's two-column
-- check journey_moments_check; pg-mem names them differently, and the tests drop its names first.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_display_name_check;
ALTER TABLE users ADD CONSTRAINT users_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 800);

ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_name_check;
ALTER TABLE journeys ADD CONSTRAINT journeys_name_check CHECK (char_length(name) BETWEEN 1 AND 800);
ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_location_check;
ALTER TABLE journeys ADD CONSTRAINT journeys_location_check CHECK (char_length(location) <= 800);

ALTER TABLE journey_moments DROP CONSTRAINT IF EXISTS journey_moments_title_check;
ALTER TABLE journey_moments ADD CONSTRAINT journey_moments_title_check CHECK (char_length(title) BETWEEN 1 AND 1200);
ALTER TABLE journey_moments DROP CONSTRAINT IF EXISTS journey_moments_kind_label_check;
ALTER TABLE journey_moments ADD CONSTRAINT journey_moments_kind_label_check CHECK (char_length(kind_label) <= 600);
ALTER TABLE journey_moments DROP CONSTRAINT IF EXISTS journey_moments_check;
ALTER TABLE journey_moments ADD CONSTRAINT journey_moments_check CHECK ((kind = 'other' AND char_length(kind_label) BETWEEN 1 AND 600) OR (kind <> 'other' AND kind_label = ''));
