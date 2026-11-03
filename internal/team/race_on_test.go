//go:build race

package team

// raceEnabled is true when the tests run under the race detector, which
// slows every memory access several times over. A wall-clock ceiling then
// measures the detector, not the code.
const raceEnabled = true
