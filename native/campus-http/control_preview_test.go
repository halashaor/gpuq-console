package main

import (
	"testing"
	"time"
)

func TestPreviewControlRetainsMetadataOnlyRules(t *testing.T) {
	for _, path := range []string{"/api/call", "/__preview__/api/call"} {
		f := frame{Control: &controlSpec{Origin: "https://portal.example", Path: path}}
		if err := validateControl(f); err != nil {
			t.Fatal(err)
		}
		if !controlBodyAllowed(path, []byte(`{"operation":"state","args":{}}`)) {
			t.Fatal("state denied")
		}
		for _, op := range []string{"files.put", "files.get", "datasets.upload.chunk", "datasets.upload.manifest", "transfers.io"} {
			if controlBodyAllowed(path, []byte(`{"operation":"`+op+`","args":{}}`)) {
				t.Fatalf("file relay accepted: %s %s", path, op)
			}
		}
		if controlBodyAllowed(path, []byte(`{"unexpected":true}`)) {
			t.Fatal("malformed call accepted")
		}
		if controlRequestTimeout(path, []byte(`{"operation":"projects.publish","args":{}}`)) != 180*time.Second {
			t.Fatal("publication timeout changed")
		}
	}
	for _, path := range []string{"/__preview__/api/login", "/__preview__/api/register", "/other/api/call"} {
		if validateControl(frame{Control: &controlSpec{Origin: "https://portal.example", Path: path}}) == nil {
			t.Fatal("unexpected path accepted", path)
		}
	}
}
