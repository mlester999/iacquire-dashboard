// The letters in the small tile that stands for a business on its customer pages. Pure, so the browser bundle and the server can both use it.
//
// They come from the words of the name that start with a letter or a digit. A tag in brackets such as "(QA)" and a symbol such as "&" are not words to take a letter from: the
// tile for "Harbor Home Services (QA)" used to read "H(". With two or more such words it is the first letter of the first and of the last; with one it is the first two letters
// of that word; with none (a name made only of symbols and brackets) it is the first two letters or digits there are, and "?" when there are none.

const STARTS_WITH_LETTER_OR_DIGIT = /^[\p{L}\p{N}]/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

// By code point, so a letter outside the basic plane is not cut in half.
const firstChar = (s: string) => [...s][0] ?? "";
const firstTwoLettersOf = (s: string) => [...s].filter((c) => LETTER_OR_DIGIT.test(c)).slice(0, 2).join("");

export function businessInitials(name: string | null | undefined): string {
  // Composed form, so "é" typed as an e and an accent is one letter.
  const text = (name ?? "").normalize("NFC");
  const words = text.split(/\s+/).filter((w) => STARTS_WITH_LETTER_OR_DIGIT.test(w));
  const letters = words.length >= 2 ? firstChar(words[0]) + firstChar(words[words.length - 1]) : words.length === 1 ? firstTwoLettersOf(words[0]) : firstTwoLettersOf(text);
  return letters ? letters.toUpperCase() : "?";
}
