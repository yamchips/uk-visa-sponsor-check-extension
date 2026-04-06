const { createIndex, matchCompanyNames } = require("../chrome-extension/shared/matcher-core.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const sponsorNames = [
  "BOOKING.COM LIMITED",
  "Kaplan Financial Limited",
  "A4 RETAIL LIMITED T/A Braes Of Kirriemuir",
  "AJ'S STORES LTD",
  "VISA EUROPE LIMITED",
  "Airbus Defence and Space Limited",
  "Legal & General Resources Ltd",
  "L&G - Asset Management Limited"
];

const index = createIndex(sponsorNames);

const bookingResult = matchCompanyNames(["Booking.com"], index);
assert(bookingResult.matched, "Expected Booking.com to match BOOKING.COM LIMITED");

const kaplanResult = matchCompanyNames(["Kaplan Higher Education"], index);
assert(kaplanResult.matched, "Expected Kaplan Higher Education to match a Kaplan sponsor alias");

const tradingAsResult = matchCompanyNames(["Braes Of Kirriemuir"], index);
assert(tradingAsResult.matched, "Expected the trading-as name to match");

const punctuationResult = matchCompanyNames(["AJs Stores"], index);
assert(punctuationResult.matched, "Expected punctuation-insensitive matching to work");

const visaResult = matchCompanyNames(["Visa"], index);
assert(visaResult.matched, "Expected Visa to match VISA EUROPE LIMITED via brand alias");

const airbusResult = matchCompanyNames(["Airbus Defence and Space"], index);
assert(airbusResult.matched, "Expected Airbus Defence and Space to match the Airbus sponsor entry");

const legalAndGeneralResult = matchCompanyNames(["Legal & General"], index);
assert(
  legalAndGeneralResult.matched,
  "Expected Legal & General to match Legal & General Resources Ltd via coordinated brand alias"
);

const legalAndGeneralTextResult = matchCompanyNames(["Legal and General"], index);
assert(
  legalAndGeneralTextResult.matched,
  "Expected Legal and General to match the Legal & General sponsor entries"
);

const lAndGResult = matchCompanyNames(["L&G"], index);
assert(lAndGResult.matched, "Expected L&G to match the Legal & General sponsor entries");

const visaMigrationResult = matchCompanyNames(["Visa and Migration"], index);
assert(!visaMigrationResult.matched, "Expected Visa and Migration not to match VISA EUROPE LIMITED");

const falsePositiveResult = matchCompanyNames(["Booking Whizz Limited"], index);
assert(!falsePositiveResult.matched, "Expected Booking Whizz Limited not to match BOOKING.COM LIMITED");

console.log("Matcher tests passed.");
