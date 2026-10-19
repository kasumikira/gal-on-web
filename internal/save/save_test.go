package save

import (
	"bytes"
	"errors"
	"path/filepath"
	"testing"
)

func open(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "savedata.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func TestWriteListRead(t *testing.T) {
	store := open(t)
	data := []byte("kirikiri save payload")
	file, err := store.Write("/savedata/scn/001.ks", data)
	if err != nil {
		t.Fatal(err)
	}
	if file.Path != "/savedata/scn/001.ks" || file.Size != int64(len(data)) {
		t.Fatalf("write returned %+v", file)
	}

	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Path != file.Path || list[0].Size != file.Size {
		t.Fatalf("list returned %+v", list)
	}

	// Offsets and lengths index the bytes exactly, including the last byte.
	for _, test := range []struct{ offset, length int64 }{{0, int64(len(data))}, {0, 5}, {4, 6}, {int64(len(data)) - 1, 1}, {0, 0}} {
		got, err := store.Read(file.Path, test.offset, test.length)
		if err != nil {
			t.Fatalf("read %+v: %v", test, err)
		}
		want := data[test.offset:min(test.offset+test.length, int64(len(data)))]
		if !bytes.Equal(got, want) {
			t.Fatalf("read %+v = %q, want %q", test, got, want)
		}
	}
}

func TestOverwriteAndDelete(t *testing.T) {
	store := open(t)
	if _, err := store.Write("/savedata/a.sav", []byte("first")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Write("/savedata/a.sav", []byte("second value")); err != nil {
		t.Fatal(err)
	}
	list, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("overwrite produced %d rows", len(list))
	}
	if list[0].Size != int64(len("second value")) {
		t.Fatalf("overwrite kept size %d", list[0].Size)
	}
	removed, err := store.Delete("/savedata/a.sav")
	if err != nil || !removed {
		t.Fatalf("delete = %v, %v", removed, err)
	}
	removed, err = store.Delete("/savedata/a.sav")
	if err != nil || removed {
		t.Fatalf("second delete = %v, %v", removed, err)
	}
	if _, err := store.Size("/savedata/a.sav"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("size of deleted file = %v", err)
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"savedata/a.sav":       "/savedata/a.sav",
		"/savedata//a.sav":     "/savedata/a.sav",
		"/savedata/../b.sav":   "/b.sav",
		`\savedata\a.sav`:      "/savedata/a.sav",
		"/savedata/シナリオ.sav": "/savedata/シナリオ.sav",
	}
	for input, want := range cases {
		if got := Normalize(input); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", input, got, want)
		}
	}
	// A name with relative segments addresses the same row as its clean form.
	store := open(t)
	if _, err := store.Write("/savedata/../saves/b.sav", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Size("/saves/b.sav"); err != nil {
		t.Fatalf("normalized lookup failed: %v", err)
	}
}
