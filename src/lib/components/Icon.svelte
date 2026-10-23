<script lang="ts">
  import { mdiPlay, mdiCameraOutline, mdiStarOutline, mdiOpenInNew, mdiFilterVariant, mdiViewGrid, mdiImageOutline, mdiUpload, mdiDownload, mdiFolderOutline, mdiMagnify, mdiChevronRight, mdiClose, mdiCheck, mdiSelectAll, mdiTrashCanOutline, mdiSelectOff, mdiAccountMinusOutline, mdiCheckboxIntermediate, mdiRefresh, mdiSort, mdiSortAscending, mdiSortDescending, mdiLogout, mdiLockOutline, mdiAccountOutline, mdiAccountGroupOutline, mdiClockOutline, mdiInformationOutline, mdiArrowRight, mdiAutoFix } from '@mdi/js';
  export let name = 'grid';
  export let size = 20;
  const paths: Record<string, string> = {
    'play': mdiPlay,
    'camera': mdiCameraOutline,
    'star': mdiStarOutline,
    'external': mdiOpenInNew,
    'filter': mdiFilterVariant,
    'grid': mdiViewGrid,
    'image': mdiImageOutline,
    'upload': mdiUpload,
    'download': mdiDownload,
    'folder': mdiFolderOutline,
    'search': mdiMagnify,
    'chevron': mdiChevronRight,
    'close': mdiClose,
    'delete': mdiTrashCanOutline,
    'check': mdiCheck,
    'select-all': mdiSelectAll,
    'select-none': mdiSelectOff,
    'select-others': mdiAccountMinusOutline,
    'select-some': mdiCheckboxIntermediate,
    'refresh': mdiRefresh,
    'sort': mdiSort,
    'sort-ascending': mdiSortAscending,
    'sort-descending': mdiSortDescending,
    'logout': mdiLogout,
    'lock': mdiLockOutline,
    'user': mdiAccountOutline,
    'people': mdiAccountGroupOutline,
    'clock': mdiClockOutline,
    'info': mdiInformationOutline,
    'arrow': mdiArrowRight,
    'spark': mdiAutoFix,
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={paths[name] || paths.image} /></svg>
