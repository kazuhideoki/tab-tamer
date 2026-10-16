.DEFAULT_GOAL := help
.PHONY: help install update apply status

help:
	@printf '%s\n' \
	  'make install  初回登録（ビルド → Braveで読込 → 設定反映）' \
	  'make update   拡張コード更新（ビルド → Braveで再読込 → 設定確認）' \
	  'make apply    config.toml の変更を反映' \
	  'make status   反映済み設定を確認'

install:
	@test -f config.toml || cp config.example.toml config.toml
	./tab-tamer validate
	./tab-tamer build
	@printf '\n%s\n' \
	  'Braveで brave://extensions を開き、デベロッパーモードを有効にしてください。' \
	  '「パッケージ化されていない拡張機能を読み込む」で次のフォルダを選択します。'
	@pwd | sed 's|$$|/dist|'
	@printf '%s\n' '既存のタブ整理拡張は無効にしてください。'
	@printf '読み込み後に Enter（中止は Ctrl+C）: '; read answer
	./tab-tamer apply

update:
	./tab-tamer build
	@printf '\n%s\n' \
	  'Braveで brave://extensions を開き、Tab Tamerの再読み込みボタンを押してください。' \
	  '設定は保持されます。設定ファイルも変更した場合は make apply を実行してください。'
	@printf '再読み込み後に Enter（中止は Ctrl+C）: '; read answer
	./tab-tamer status

apply:
	./tab-tamer apply

status:
	./tab-tamer status
