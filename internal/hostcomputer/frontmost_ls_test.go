package hostcomputer

import "testing"

func TestParseLSAppInfoReadsNameBundleAndPID(t *testing.T) {
	out := "\"Google Chrome\" ASN:0x0-0x12345: (in front) \n    bundleID=\"com.google.Chrome\"\n    pid = 1386 type=\"Foreground\"\n"
	app, ok := parseLSAppInfo(out)
	if !ok || app.Name != "Google Chrome" || app.BundleID != "com.google.Chrome" || app.PID != 1386 || !app.Running {
		t.Fatalf("parsed %+v ok=%v", app, ok)
	}
	if _, ok := parseLSAppInfo("\"Thing\" ASN:0x0-0x1:\n    bundleID=\"x\"\n"); ok {
		t.Fatal("an app without a pid counted")
	}
	if _, ok := parseLSAppInfo(""); ok {
		t.Fatal("empty output counted")
	}
}
