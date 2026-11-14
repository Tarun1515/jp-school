/*==============================================================================
  THE SIX FIELDS THE CLIENT MADE COMPULSORY — SR-6

  School type · Board · Affiliation number · Registration number · PAN ·
  Established year.

  ------------------------------------------------------------------------------
  🔴 WHY THIS IS A MODULE AND NOT TWO BLOCKS OF CODE
  ------------------------------------------------------------------------------
  The same six facts are collected in two completely different places — the
  registration form (`features/account/registration`) and the school profile
  (`features/school/profile`) — and from SR-6 they are REQUIRED in both. Written
  twice, the two copies would start identical and then drift the first time
  somebody reworded one message or widened one rule, and the screen nobody
  opened in testing would be the one left behind.

  So the rule and its wording live here once. G27's reason, and the same shape
  the product already uses for a rule two screens share.

  ------------------------------------------------------------------------------
  🔴 THIS IS NOT THE ENFORCEMENT. THE SERVER IS.
  ------------------------------------------------------------------------------
  `/registration/draft/{id}/submit` and `USP_UpdateSchoolProfile` refuse all six
  independently, and they are what actually holds — a client is a convenience
  and can be skipped by anything that is not this UI.

  What this file buys is the refusal arriving BEFORE the round trip, beside the
  box it is about, in a sentence written for the person reading it rather than
  for an API consumer. If the two ever disagree, the server wins and the fix
  belongs here.

  ⚠️ WHICH MEANS THE RULES BELOW MUST NOT BE STRICTER THAN THE SERVER'S. A
  client that refuses a PAN the API would have accepted is a school that cannot
  register and has been given no way to find out why. The PAN pattern is the
  server's, character for character; the two certificate numbers are checked for
  PRESENCE ONLY, deliberately (see the note on them below).
==============================================================================*/

/**
 * The six, in the order they appear on both screens.
 *
 * ⚠️ THE KEYS ARE THE PAYLOAD'S OWN NAMES, which is what lets both callers loop
 * over this list and index their own body type with it — `SaveDraftBody` and
 * `UpdateSchoolProfileBody` happen to agree on all six, and that agreement is
 * the reason one list can serve them.
 */
export const COMPULSORY_SCHOOL_FIELDS = [
  'schoolTypeId',
  'boardId',
  'affiliationNumber',
  'registrationNo',
  'panNumber',
  'establishedYear',
] as const;

export type CompulsorySchoolField = (typeof COMPULSORY_SCHOOL_FIELDS)[number];

/**
 * What each field is called in a sentence — lower case, mid-sentence.
 *
 * Used by the profile's "still to fill in" prompt, which has to name them in a
 * list. Not used for labels: a <label> is title case and belongs in the
 * template beside its control.
 */
export const COMPULSORY_SCHOOL_FIELD_LABELS: Record<CompulsorySchoolField, string> = {
  schoolTypeId: 'school type',
  boardId: 'board',
  affiliationNumber: 'affiliation number',
  registrationNo: 'registration number',
  panNumber: 'PAN',
  establishedYear: 'year established',
};

/** Five letters, four digits, one letter. Mirrors the server's rule exactly. */
export const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * The earliest year a school may claim.
 *
 * ⚠️ There is no upper constant to match it: the upper bound is THIS year, read
 * at the moment of the check. A number baked in here goes stale every January,
 * and the January it goes stale is the January a school founded that year
 * cannot register.
 */
export const EARLIEST_ESTABLISHED_YEAR = 1800;

/**
 * Whether one of the six is acceptable, and what to say when it is not.
 *
 * Returns null when the value is fine, or the sentence to show under the field.
 *
 * ----------------------------------------------------------------------------
 * 🔴 MISSING AND MALFORMED ARE DIFFERENT MESSAGES, WHERE BOTH CAN HAPPEN
 * ----------------------------------------------------------------------------
 * PAN and the year each have two ways to be wrong, made by two different people
 * with two different things to do about it:
 *
 *   MISSING — they have not got the document out. "A PAN is ten characters…"
 *     in front of an empty box reads as a format complaint about nothing, and
 *     it does not tell them what to go and find.
 *
 *   MALFORMED — the document is in their hand and they have mistyped it. Here
 *     the format IS the useful thing to say, with an example.
 *
 * While PAN was optional only the malformed case could exist, so one message
 * was all there was. Requiring the field adds the other one; it does not change
 * the one that was already right.
 *
 * ⚠️ THE TWO MASTERS HAVE NO MALFORMED CASE. A combobox commits an id from the
 * list or nothing at all, so "missing" is the only failure a user can produce —
 * and inventing a second message for an id that is not in the master would be
 * writing copy for a state the UI cannot reach.
 */
export function compulsorySchoolFieldError(
  field: CompulsorySchoolField,
  value: string | number | null | undefined,
): string | null {
  switch (field) {
    case 'schoolTypeId':
      return value
        ? null
        : 'Choose the kind of school this is. Teachers filter their search by it.';

    case 'boardId':
      return value
        ? null
        : 'Choose your board. It is the first thing a teacher looks for on a job post.';

    /*
      🔴 THE TWO CERTIFICATE NUMBERS ARE CHECKED FOR PRESENCE AND NOTHING ELSE,
      AND THAT IS DELIBERATE.

      Every board formats an affiliation number differently — CBSE/2011/34120, a
      bare six digits, a state board's own scheme — and a registration number
      comes off whatever society or trust certificate the school happens to
      hold. A pattern here would refuse real numbers, which is a far worse
      failure than accepting a typo: the registration step after this one asks
      for the certificate itself, and a human compares the two.
    */
    case 'affiliationNumber':
      return isBlank(value)
        ? 'Your affiliation number, exactly as it appears on the board certificate.'
        : null;

    case 'registrationNo':
      return isBlank(value)
        ? 'The registration number on your school, society or trust certificate.'
        : null;

    case 'panNumber': {
      if (isBlank(value)) {
        return 'We need the school’s PAN — it is how we confirm the school is a registered entity.';
      }

      /*
        ⚠️ UPPERCASED BEFORE THE TEST, because the pattern is upper case and the
        input's `text-transform: uppercase` is paint rather than value. Both
        callers also uppercase what they STORE, so this is belt and braces for a
        draft written before SR-6 — not the fix for that problem.
      */
      return PAN_FORMAT.test(String(value).trim().toUpperCase())
        ? null
        : 'A PAN is ten characters — five letters, four digits, then a letter. For example ABCDE1234F.';
    }

    case 'establishedYear': {
      /*
        ⚠️ `!value` IS THE EMPTY TEST AND IT ALSO CATCHES 0 — correct here. An
        empty <input type="number"> commits null, which is the ordinary path; a
        literal 0 is a typed mistake, and "the year the school opened" is a
        better reply to it than a range complaint.
      */
      if (!value) {
        return 'The year the school opened. Teachers see it beside your name.';
      }

      const year = Number(value);
      const thisYear = new Date().getFullYear();

      return year >= EARLIEST_ESTABLISHED_YEAR && year <= thisYear
        ? null
        : `That year does not look right — it should be a four-digit year between ${EARLIEST_ESTABLISHED_YEAR} and ${thisYear}.`;
    }
  }
}

/** Empty, or nothing but whitespace. */
function isBlank(value: string | number | null | undefined): boolean {
  return value === null || value === undefined || String(value).trim().length === 0;
}
