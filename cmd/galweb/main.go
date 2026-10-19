package main

import (
	"flag"
	"log"
	"net/http"
	"path/filepath"

	"gal-on-web/internal/library"
	"gal-on-web/internal/save"
	"gal-on-web/internal/server"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	root := flag.String("game", "", "game directory containing data.xp3")
	web := flag.String("web", "web/build", "frontend build directory")
	engine := flag.String("engine", "krkr-js", "browser engine adapter")
	entry := flag.String("entry", "data.xp3", "game entry relative to game directory")
	savePath := flag.String("save", "tests/savedata.sqlite", "SQLite file holding emulated save data")
	flag.Parse()
	if *root == "" {
		matches, err := filepath.Glob("tests/*/data.xp3")
		if err != nil || len(matches) != 1 {
			log.Fatal("specify -game: expected exactly one tests/*/data.xp3")
		}
		*root = filepath.Dir(matches[0])
	}
	abs, err := filepath.Abs(*root)
	if err != nil {
		log.Fatal(err)
	}
	game, err := library.Scan(abs, *engine, *entry)
	if err != nil {
		log.Fatal(err)
	}
	saves, err := save.Open(*savePath)
	if err != nil {
		log.Fatal(err)
	}
	defer saves.Close()
	// Keep the database self-describing: a copied file names its game.
	if err := saves.SetMeta("game.id", game.ID); err != nil {
		log.Fatal(err)
	}
	if err := saves.SetMeta("game.entry", game.Entry); err != nil {
		log.Fatal(err)
	}
	log.Printf("%s: %d files; saves in %s; open http://%s", game.Title, len(game.Files), saves.Path(), *addr)
	log.Fatal(http.ListenAndServe(*addr, server.New(abs, *web, game, saves)))
}
