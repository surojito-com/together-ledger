ALTER TABLE journey_moments DROP CONSTRAINT IF EXISTS journey_moments_kind_check;
-- pg-mem assigns anonymous CHECK names while PostgreSQL derives the name above.
ALTER TABLE journey_moments DROP CONSTRAINT IF EXISTS journey_moments_constraint_1;
ALTER TABLE journey_moments ADD CONSTRAINT journey_moments_kind_check CHECK (kind IN ('promise','acknowledgment','trigger','missed-chance','heart-to-heart','memory','feeling','boundary','repair-request','learned-something','call-me','called-you','practical-matter','other'));
