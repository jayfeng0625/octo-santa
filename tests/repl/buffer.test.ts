import { describe, it, expect } from "bun:test";
import { InputBuffer } from "../../src/repl/buffer";

describe("InputBuffer", () => {
  describe("creation", () => {
    it("starts with empty single line", () => {
      const buf = new InputBuffer();
      expect(buf.lines).toEqual([""]);
      expect(buf.cursorRow).toBe(0);
      expect(buf.cursorCol).toBe(0);
    });
  });

  describe("insert", () => {
    it("inserts text at cursor", () => {
      const buf = new InputBuffer();
      buf.insert("hello");
      expect(buf.lines).toEqual(["hello"]);
      expect(buf.cursorCol).toBe(5);
    });

    it("inserts at cursor position mid-line", () => {
      const buf = new InputBuffer();
      buf.insert("helo");
      buf.move("left");
      buf.insert("l");
      expect(buf.lines).toEqual(["hello"]);
      expect(buf.cursorCol).toBe(4);
    });

    it("inserts newline splitting the line", () => {
      const buf = new InputBuffer();
      buf.insert("helloworld");
      buf.move("left"); buf.move("left"); buf.move("left"); buf.move("left"); buf.move("left");
      buf.insert("\n");
      expect(buf.lines).toEqual(["hello", "world"]);
      expect(buf.cursorRow).toBe(1);
      expect(buf.cursorCol).toBe(0);
    });

    it("inserts multiline text in one call", () => {
      const buf = new InputBuffer();
      buf.insert("line1\nline2\nline3");
      expect(buf.lines).toEqual(["line1", "line2", "line3"]);
      expect(buf.cursorRow).toBe(2);
      expect(buf.cursorCol).toBe(5);
    });
  });

  describe("backspace", () => {
    it("deletes character before cursor", () => {
      const buf = new InputBuffer();
      buf.insert("hello");
      buf.backspace();
      expect(buf.lines).toEqual(["hell"]);
      expect(buf.cursorCol).toBe(4);
    });

    it("joins lines when at start of line", () => {
      const buf = new InputBuffer();
      buf.insert("hello\nworld");
      buf.move("home"); // start of "world"
      buf.backspace();
      expect(buf.lines).toEqual(["helloworld"]);
      expect(buf.cursorRow).toBe(0);
      expect(buf.cursorCol).toBe(5);
    });

    it("does nothing at start of buffer", () => {
      const buf = new InputBuffer();
      buf.backspace();
      expect(buf.lines).toEqual([""]);
    });
  });

  describe("delete", () => {
    it("deletes character after cursor", () => {
      const buf = new InputBuffer();
      buf.insert("hello");
      buf.move("home");
      buf.delete();
      expect(buf.lines).toEqual(["ello"]);
    });

    it("joins lines when at end of line", () => {
      const buf = new InputBuffer();
      buf.insert("hello\nworld");
      buf.move("up");
      buf.move("end");
      buf.delete();
      expect(buf.lines).toEqual(["helloworld"]);
    });
  });

  describe("deleteWord", () => {
    it("deletes word backward", () => {
      const buf = new InputBuffer();
      buf.insert("hello world");
      buf.deleteWord();
      expect(buf.lines).toEqual(["hello "]);
    });

    it("deletes through punctuation", () => {
      const buf = new InputBuffer();
      buf.insert("foo.bar");
      buf.deleteWord();
      expect(buf.lines).toEqual(["foo."]);
    });
  });

  describe("deleteToEnd", () => {
    it("deletes from cursor to end of line", () => {
      const buf = new InputBuffer();
      buf.insert("hello world");
      buf.move("home");
      buf.move("right"); buf.move("right"); buf.move("right"); buf.move("right"); buf.move("right");
      buf.deleteToEnd();
      expect(buf.lines).toEqual(["hello"]);
    });
  });

  describe("deleteToStart", () => {
    it("deletes from cursor to start of line", () => {
      const buf = new InputBuffer();
      buf.insert("hello world");
      buf.move("home");
      buf.move("right"); buf.move("right"); buf.move("right"); buf.move("right"); buf.move("right");
      buf.deleteToStart();
      expect(buf.lines).toEqual([" world"]);
      expect(buf.cursorCol).toBe(0);
    });
  });

  describe("word movement", () => {
    it("wordLeft skips to start of current word", () => {
      const buf = new InputBuffer();
      buf.insert("hello world");
      buf.move("wordLeft");
      expect(buf.cursorCol).toBe(6);
    });

    it("wordRight skips to start of next word", () => {
      const buf = new InputBuffer();
      buf.insert("hello world");
      buf.move("home");
      buf.move("wordRight");
      expect(buf.cursorCol).toBe(6);
    });

    it("treats foo_bar as one word", () => {
      const buf = new InputBuffer();
      buf.insert("foo_bar baz");
      buf.move("home");
      buf.move("wordRight");
      expect(buf.cursorCol).toBe(8);
    });

    it("treats foo.bar as two words", () => {
      const buf = new InputBuffer();
      buf.insert("foo.bar");
      buf.move("home");
      buf.move("wordRight");
      // skip "foo", then skip "."
      expect(buf.cursorCol).toBe(4);
    });
  });

  describe("submit", () => {
    it("returns text and resets buffer", () => {
      const buf = new InputBuffer();
      buf.insert("hello\nworld");
      const text = buf.submit();
      expect(text).toBe("hello\nworld");
      expect(buf.lines).toEqual([""]);
      expect(buf.cursorRow).toBe(0);
      expect(buf.cursorCol).toBe(0);
    });
  });

  describe("up/down with preferredCol", () => {
    it("preserves column when moving through shorter lines", () => {
      const buf = new InputBuffer();
      buf.insert("long line here\nhi\nlong line here");
      buf.move("up"); // on "hi", col clamps to 2
      expect(buf.cursorCol).toBe(2);
      buf.move("up"); // back on first line, restores to 14
      expect(buf.cursorCol).toBe(14);
    });
  });

  describe("deleteWord edge cases", () => {
    it("does nothing at start of buffer", () => {
      const buf = new InputBuffer();
      buf.insert("hello");
      buf.move("home");
      buf.deleteWord();
      expect(buf.lines).toEqual(["hello"]);
      expect(buf.cursorCol).toBe(0);
    });
  });

  describe("word movement across lines", () => {
    it("wordLeft at start of line moves to end of previous line", () => {
      const buf = new InputBuffer();
      buf.insert("hello\nworld");
      buf.move("home"); // start of "world"
      buf.move("wordLeft");
      expect(buf.cursorRow).toBe(0);
      expect(buf.cursorCol).toBe(5);
    });

    it("wordRight at end of line moves to start of next line", () => {
      const buf = new InputBuffer();
      buf.insert("hello\nworld");
      buf.move("up");
      buf.move("end"); // end of "hello"
      buf.move("wordRight");
      expect(buf.cursorRow).toBe(1);
      expect(buf.cursorCol).toBe(0);
    });
  });

  describe("clear", () => {
    it("resets buffer to empty state", () => {
      const buf = new InputBuffer();
      buf.insert("hello\nworld");
      buf.clear();
      expect(buf.lines).toEqual([""]);
      expect(buf.cursorRow).toBe(0);
      expect(buf.cursorCol).toBe(0);
      expect(buf.preferredCol).toBeNull();
    });
  });

  describe("getText", () => {
    it("returns joined lines", () => {
      const buf = new InputBuffer();
      buf.insert("hello\nworld");
      expect(buf.getText()).toBe("hello\nworld");
    });
  });

  describe("isMultiline", () => {
    it("returns false for single line", () => {
      const buf = new InputBuffer();
      buf.insert("hello");
      expect(buf.isMultiline()).toBe(false);
    });

    it("returns true for multiple lines", () => {
      const buf = new InputBuffer();
      buf.insert("hello\nworld");
      expect(buf.isMultiline()).toBe(true);
    });
  });
});
