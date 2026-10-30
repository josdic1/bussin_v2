// Made-up people for the demo copy. Nothing here belongs to anyone real.

export const KID_FIRST = [
  "Ava", "Noah", "Mia", "Leo", "Zoe", "Eli", "Lily", "Max", "Ella", "Sam", "Nora", "Theo", "Ruby", "Jack", "Ivy",
  "Owen", "Maya", "Finn", "Lucy", "Ben", "Hazel", "Caleb", "Stella", "Jonah", "Clara", "Ezra", "Rosa", "Milo",
  "Tessa", "Abe", "Gemma", "Ira", "June", "Levi", "Nina", "Reed", "Sadie", "Toby", "Willa", "Asher", "Dina",
  "Gabe", "Iris", "Jude", "Lena", "Micah", "Opal", "Ravi", "Sena", "Tali"
];
export const ADULT_FIRST = [
  "Rachel", "David", "Sarah", "Michael", "Laura", "Daniel", "Emily", "Josh", "Hannah", "Adam", "Rebecca", "Jason",
  "Leah", "Brian", "Megan", "Eric", "Allison", "Kevin", "Dana", "Scott", "Jill", "Matt", "Erin", "Greg", "Amy",
  "Paul", "Karen", "Steve", "Beth", "Mark", "Julie", "Tom", "Nicole", "Jeff", "Lisa", "Chris", "Wendy", "Alan"
];
export const LAST = [
  "Abrams", "Becker", "Carter", "Dalton", "Ellis", "Fischer", "Golden", "Hart", "Irving", "Jacobs", "Klein", "Levin",
  "Marsh", "Nolan", "Orloff", "Price", "Quinn", "Rosen", "Stone", "Tobin", "Unger", "Vance", "Walsh", "Young",
  "Zeller", "Baker", "Cohen", "Drake", "Engel", "Frost", "Gray", "Hale", "Kaplan", "Lowe", "Mercer", "Noble",
  "Porter", "Reyes", "Shaw", "Turner", "Weiss", "Burke", "Cole", "Dunn", "Fox", "Glass", "Hughes", "Katz"
];

export const pick = <T>(list: readonly T[], n: number): T => list[n % list.length]!;
/** 973-555-01xx and up: the 555-01 block is set aside for fiction. */
export const fakePhone = (n: number) => `973-555-${String(100 + (n % 9900)).padStart(4, "0")}`;
export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
