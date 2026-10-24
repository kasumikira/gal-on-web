#include <vector>

/**
 * 出力処理用インターフェース
 */
class IWriter {
protected:
	const tjs_char *newlinestr;
public:
	int indent;
        bool hex;
	IWriter(int newlinetype=0) {
		indent = 0;
                hex = false;
		switch (newlinetype) {
		case 1:
			newlinestr = TJS_W("\n");
			break;
		default:
			newlinestr  = TJS_W("\r\n");
			break;
		}
	}
	virtual ~IWriter(){};
	virtual void write(const tjs_char *str) = 0;
	virtual void write(tjs_char ch) = 0;
	virtual void write(tTVReal) = 0;
	virtual void write(tTVInteger) = 0;

	inline void newline() {
		write(newlinestr);
		for (int i=0;i<indent;i++) {
			write((tjs_char)' ');
		}
	}

	inline void addIndent() {
		indent++;
		newline();
	}

	inline void delIndent() {
		indent--;
		newline();
	}
};

/**
 * 文字列出力
 */
class IStringWriter : public IWriter {

public:
	ttstr buf;
	/**
	 * コンストラクタ
	 */
	IStringWriter(int newlinetype=0) : IWriter(newlinetype) {};

	virtual void write(const tjs_char *str) {
		buf += str;
	}

	virtual void write(tjs_char ch) {
		buf += ch;
	}

	virtual void write(tTVReal num) {
               if (hex) {
                 tTJSVariantString *str = TJSRealToHexString(num);
                 buf += str;
                 str->Release();
                 buf += TJS_W(" /* ");
                 str = TJSRealToString(num);
                 buf += str;
                 str->Release();
                 buf += TJS_W(" */");
               } else {
                 tTJSVariantString *str = TJSRealToString(num);
                 buf += str;
                 str->Release();
               }
	}

	virtual void write(tTVInteger num) {
		tTJSVariantString *str = TJSIntegerToString(num);
		buf += str;
		str->Release();
	}
};

/**
 * ファイル出力
 */
class IFileWriter : public IWriter {

	/// 出力バッファ
	ttstr buf;
	/// 出力ストリーム
	tTJSBinaryStream *stream;
	bool utf;
	std::vector<char> dat;
	
public:

	/**
	 * コンストラクタ
	 */
	IFileWriter(const tjs_char *filename, bool utf=false, int newlinetype=0) : IWriter(newlinetype) {
		stream = TJSCreateBinaryStreamForWrite(ttstr(filename), ttstr());
		this->utf = utf;
	}

	/**
	 * デストラクタ
	 */
	~IFileWriter() {
		if (stream) {
			if (buf.length() > 0) {
				output();
			}
			//stream->Commit(STGC_DEFAULT);
			delete stream;
		}
	}
	
	void output() {
		if (stream && buf.length() > 0) {
			ULONG s;
			if (utf) {
				// UTF-8で出力
				int len = TVPWideCharToUtf8String(buf.c_str(), NULL);
				if (len+1 > dat.size()) {
					dat.resize(len+1);
				}
				len = TVPWideCharToUtf8String(buf.c_str(), &dat[0]);
				s = stream->Write(&dat[0], len);
			} else {
				// 現在のコードページで出力
				int len = buf.GetNarrowStrLen();
				if (len+1 > dat.size()) {
					dat.resize(len+1);
				}
				buf.ToNarrowStr(&dat[0], len);
				s = stream->Write(&dat[0], len);
			}
		}
		buf.Clear();
	}
	
	virtual void write(const tjs_char *str) {
		if (stream) {
			buf += str;
			if (buf.length() >= 1024) {
				output();
			}
		}
	}

	virtual void write(tjs_char ch) {
		buf += ch;
	}

	virtual void write(tTVReal num) {
               if (hex) {
                 tTJSVariantString *str = TJSRealToHexString(num);
                 buf += str;
                 str->Release();
                 buf += TJS_W(" /* ");
                 str = TJSRealToString(num);
                 buf += str;
                 str->Release();
                 buf += TJS_W(" */");
               } else {
                 tTJSVariantString *str = TJSRealToString(num);
                 buf += str;
                 str->Release();
               }
	}

	virtual void write(tTVInteger num) {
		tTJSVariantString *str = TJSIntegerToString(num);
		buf += str;
		str->Release();
	}
};

