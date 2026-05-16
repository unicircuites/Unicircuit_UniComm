const testString = "ðŸ“·";
try {
  console.log('Original:', testString);
  console.log('Fixed:', decodeURIComponent(escape(testString)));
} catch (e) {
  console.error(e);
}
