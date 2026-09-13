package git

// Windows forbids < > : " / \ | ? * in filenames, so the "箭头 -> 文件.txt" case
// from paths_unix_test.go has no counterpart here: a name containing git's
// rename arrow cannot exist on this platform, and neither can the ambiguity it
// guards against.
var platformNonASCIIPaths []string
