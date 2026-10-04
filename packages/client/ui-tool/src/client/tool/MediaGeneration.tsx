/** Dedicated media generation output, independent of tool activity disclosure. */
import { useEffect, useState } from 'react'
import type { VideoAttachmentRef } from '@hydraharness/harness-attachment'
import { IconSparkle16, writeClipboard } from '@hydraharness/harness-client-ui-primitives'
import type { MediaGenerationProps } from '../contract/slots.ts'
import { resultText } from './models/tool-call-model.ts'
import css from './MediaGeneration.module.css'

function GeneratedVideo({ attachment, loadMedia, t }: {
  attachment: VideoAttachmentRef
} & Pick<MediaGenerationProps, 'loadMedia' | 't'>) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setFailed(false)
    void loadMedia(attachment).then(
      (value) => { if (active) setUrl(value) },
      () => { if (active) setFailed(true) },
    )
    return () => { active = false }
  }, [attachment, loadMedia, attempt])
  return (
    <div className={css.video}>
      {url !== undefined && !failed ? (
        <>
          <video src={url} controls playsInline preload="metadata" aria-label={attachment.name} onError={() => { setFailed(true) }} />
          <a className={css.download} href={url} download={attachment.name}>{t('media.downloadVideo')}</a>
        </>
      ) : failed ? (
        <div role="alert">
          {t('media.videoLoadFailed')}
          <button type="button" onClick={() => { setUrl(undefined); setAttempt(value => value + 1) }}>{t('retry')}</button>
        </div>
      ) : <div role="status">{t('media.loadingVideo')}</div>}
    </div>
  )
}

/**
 * Render generation progress, durable output, or its settled error as one chat card.
 * @param props - logged call/result and the conversation's media callbacks.
 * @returns an always-visible media output.
 */
export function MediaGeneration({
  node, renderMessageImages, loadMedia, loadModelName, inspectCall, selectedCallId, t,
}: MediaGenerationProps) {
  const block = node.data.root
  const call = block.callView?.card === 'media' ? block.callView : null
  const result = 'kind' in block && block.resultView?.card === 'media' ? block.resultView : null
  const kind = result?.kind ?? call?.kind ?? 'image'
  const state = !('kind' in block) ? 'running'
    : block.isError ? block.error?.code === 'interrupted' ? 'interrupted' : 'error' : 'complete'
  const images = state === 'complete' ? result?.content.flatMap(part => part.type === 'image' ? [{ attachment: part.attachment }] : []) ?? [] : []
  const videos = state === 'complete' ? result?.content.flatMap(part => part.type === 'video' ? [part.attachment] : []) ?? [] : []
  const label = t(`media.${kind}.${state}`)
  const text = 'kind' in block ? resultText(block) : ''
  const provider = result?.provider
  const model = result?.model
  const [modelName, setModelName] = useState<string>()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let active = true
    setModelName(undefined)
    if (model !== undefined) void loadModelName(provider, model).then(
      (name) => { if (active) setModelName(name) },
      () => { if (active) setModelName(undefined) },
    )
    return () => { active = false }
  }, [loadModelName, provider, model])
  useEffect(() => {
    setCopied(false)
  }, [block.callId, call?.prompt])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => { setCopied(false) }, 1000)
    return () => { window.clearTimeout(timer) }
  }, [copied])
  return (
    <section
      className={css.root} aria-label={label} aria-busy={state === 'running'}
      data-media-generation={kind} data-state={state}
      data-chat-call-id={block.callId} data-chat-anchor-key={`call:${block.callId}`}
      data-selected={block.callId === selectedCallId || undefined}
    >
      <header className={css.header}>
        <span className={css.title}><span aria-hidden><IconSparkle16 /></span><span role="status" aria-live="polite">{label}</span></span>
        <div className={css.actions}>
          {call?.prompt !== undefined && <button type="button" className={css.details} onClick={() => {
            void writeClipboard(call.prompt).then((ok) => { if (ok) setCopied(true) })
          }}>{copied ? t('copied') : t('media.copyPrompt')}</button>}
          <button type="button" className={css.details} onClick={() => { inspectCall(block.callId) }}>{t('media.details')}</button>
        </div>
      </header>
      {call?.prompt !== undefined && <p className={css.prompt}>{call.prompt}</p>}
      {state === 'running' && <div
        className={css.placeholder} data-media-placeholder data-aspect-ratio={call?.aspectRatio} aria-hidden
        style={call?.aspectRatio === undefined ? undefined : { aspectRatio: `${call.aspectRatio} / 1` }}
      ><span className={css.orbit}><IconSparkle16 size={24} /></span></div>}
      {(state === 'error' || state === 'interrupted') && <p className={css.error} role="alert">{text || label}</p>}
      {images.length > 0 && <div className={css.output}>{renderMessageImages({ images, align: 'start', presentation: 'media' })}</div>}
      {videos.map(attachment => <GeneratedVideo key={attachment.attachmentId} attachment={attachment} loadMedia={loadMedia} t={t} />)}
      {state === 'complete' && <footer className={css.caption}>{modelName ?? model ?? text}</footer>}
    </section>
  )
}
