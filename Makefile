.PHONY: compile pack prerelease publish
compile:
	npm run compile

pack:
	vsce package

publish: pack
	vsce publish

prerelease:
	vsce package --pre-release
	vsce publish --pre-release